import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../share/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import * as Promises from '../promises';

interface KorbitMessageIncomingMessage {
    channel: string;
    success: boolean;
    data: any;
    event?: string;
    errorcode: number;
    order_id: string;
}

interface KorbitDepthMessage {
    asks: [number, number][];
    bids: [number, number][];
    timestamp: string;
}

interface OrderAck {
    result: boolean;
    order_id: number;
}

interface SignedMessage {
    client_id?: string;
    client_secret?: string;
    code?: string;
    grant_type?: string;
    username?: string;
    password?: string;
    currency_pair?: string;
}

interface TokenMessage {
    access_token: string;
    refresh_token: string;
}

interface Order extends SignedMessage {
    symbol: string;
    type: string;
    price: string;
    amount: string;
}

interface Cancel extends SignedMessage {
    order_id: string;
    symbol: string;
}

interface KorbitTradeRecord {
    averagePrice: string;
    completedTradeAmount: string;
    createdDate: string;
    id: string;
    orderId: string;
    sigTradeAmount: string;
    sigTradePrice: string;
    status: number;
    symbol: string;
    tradeAmount: string;
    tradePrice: string;
    tradeType: string;
    tradeUnitPrice: string;
    unTrade: string;
}

interface SubscriptionRequest extends SignedMessage { }

class KorbitMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrade = (trades : Models.Timestamped<[string,string,string,string,string][]>) => {
        trades.data.forEach(trade => { // [tid, price, amount, time, type]
            var px = parseFloat(trade[1]);
            var amt = parseFloat(trade[2]);
            var side = trade[4] === "ask" ? Models.Side.Ask : Models.Side.Bid;
            var mt = new Models.GatewayMarketTrade(px, amt, trades.time, trades.data.length > 0, side);
            this.MarketTrade.trigger(mt);
        });
    };

    MarketData = new Utils.Evt<Models.Market>();

    private static GetLevel = (n: [any, any]) : Models.MarketSide =>
        new Models.MarketSide(parseFloat(n[0]), parseFloat(n[1]));

    private onDepth = (depth : Models.Timestamped<KorbitDepthMessage>) => {
        var msg = depth.data;

        var bids = msg.bids.slice(0,13).map(KorbitMarketDataGateway.GetLevel);
        var asks = msg.asks.reverse().slice(0,13).map(KorbitMarketDataGateway.GetLevel);
        var mkt = new Models.Market(bids, asks, depth.time);

        this.MarketData.trigger(mkt);
    };

    constructor(_http : KorbitHttp, symbolProvider: KorbitSymbolProvider) {
        // var depthChannel = "ok_sub_spot" + symbolProvider.symbolReversed + "_depth_20";
        // var tradesChannel = "ok_sub_spot" + symbolProvider.symbolReversed + "_trades";
        // socket.setHandler(depthChannel, this.onDepth);
        // socket.setHandler(tradesChannel, this.onTrade);

        // socket.ConnectChanged.on(cs => {
            // this.ConnectChanged.trigger(cs);

            // if (cs == Models.ConnectivityStatus.Connected) {
                // socket.send(depthChannel, null);
                // socket.send(tradesChannel, null);
            // }
        // });
    }
}

class KorbitOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private chars: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    generateClientOrderId = (): string => {
      let id: string = '';
      for(let i=8;i--;) id += this.chars.charAt(Math.floor(Math.random() * this.chars.length));
      return id;
    };

    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Promise<number> => {
        var d = Promises.defer<number>();
        this._http.post("order_info.do", <Cancel>{order_id: '-1', symbol: this._symbolProvider.symbol }).then(msg => {
          if (typeof (<any>msg.data).orders == "undefined"
            || typeof (<any>msg.data).orders[0] == "undefined"
            || typeof (<any>msg.data).orders[0].order_id == "undefined") { d.resolve(0); return; }
          (<any>msg.data).orders.map((o) => {
              this._http.post("cancel_order.do", <Cancel>{order_id: o.order_id.toString(), symbol: this._symbolProvider.symbol }).then(msg => {
                  if (typeof (<any>msg.data).result == "undefined") return;
                  if ((<any>msg.data).result) {
                      this.OrderUpdate.trigger(<Models.OrderStatusUpdate>{
                        exchangeId: (<any>msg.data).order_id.toString(),
                        leavesQuantity: 0,
                        time: msg.time,
                        orderStatus: Models.OrderStatus.Cancelled
                      });
                  }
              });
          });
          d.resolve((<any>msg.data).orders.length);
        });
        return d.promise;
    };

    public cancelsByClientOrderId = false;

    private static GetOrderType(side: Models.Side, type: Models.OrderType) : string {
        if (side === Models.Side.Bid) {
            if (type === Models.OrderType.Limit) return "buy";
            if (type === Models.OrderType.Market) return "buy_market";
        }
        if (side === Models.Side.Ask) {
            if (type === Models.OrderType.Limit) return "sell";
            if (type === Models.OrderType.Market) return "sell_market";
        }
        throw new Error("unable to convert " + Models.Side[side] + " and " + Models.OrderType[type]);
    }

    // let's really hope there's no race conditions on their end -- we're assuming here that orders sent first
    // will be acked first, so we can match up orders and their acks
    private _ordersWaitingForAckQueue = [];

    sendOrder = (order : Models.OrderStatusReport) => {
        var o : Order = {
            symbol: this._symbolProvider.symbol,
            type: KorbitOrderEntryGateway.GetOrderType(order.side, order.type),
            price: order.price.toString(),
            amount: order.quantity.toString()};

        // this._ordersWaitingForAckQueue.push([order.orderId, order.quantity]);

        // this._socket.send<OrderAck>("ok_spot" + this._symbolProvider.symbolQuote + "_trade", o, () => {
            // this.OrderUpdate.trigger(<Models.OrderStatusUpdate>{
                // orderId: order.orderId,
                // computationalLatency: new Date().valueOf() - order.time.valueOf()
            // });
        // });
    };

    private onOrderAck = (ts: Models.Timestamped<OrderAck>) => {
        var order = this._ordersWaitingForAckQueue.shift();

        var orderId = order[0];
        if (typeof orderId === "undefined") {
            console.error(new Date().toISOString().slice(11, -1), 'korbit', 'got an order ack when there was no order queued!', util.format(ts.data));
            return;
        }

        var osr : Models.OrderStatusUpdate = { orderId: orderId, time: ts.time };

        if (typeof ts.data !== "undefined" && ts.data.result) {
            osr.exchangeId = ts.data.order_id.toString();
            osr.orderStatus = Models.OrderStatus.Working;
            osr.leavesQuantity = order[1];
        }
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
        }

        this.OrderUpdate.trigger(osr);
    };

    cancelOrder = (cancel : Models.OrderStatusReport) => {
        // var c : Cancel = {order_id: cancel.exchangeId, symbol: this._symbolProvider.symbol };
        // this._socket.send<OrderAck>("ok_spot" + this._symbolProvider.symbolQuote + "_cancel_order", c, () => {
            // this.OrderUpdate.trigger(<Models.OrderStatusUpdate>{
                // orderId: cancel.orderId,
                // leavesQuantity: 0,
                // time: cancel.time,
                // orderStatus: Models.OrderStatus.Cancelled
            // });
        // });
    };

    private onCancel = (ts: Models.Timestamped<OrderAck>) => {
        if (typeof ts.data.order_id == "undefined") return;
        var osr : Models.OrderStatusUpdate = {
          exchangeId: ts.data.order_id.toString(),
          time: ts.time,
          leavesQuantity: 0
        };

        if (ts.data.result) {
            osr.orderStatus = Models.OrderStatus.Cancelled;
        }
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
            osr.cancelRejected = true;
        }

        this.OrderUpdate.trigger(osr);
    };

    replaceOrder = (replace : Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };

    private static getStatus(status: number) : Models.OrderStatus {
        // status: -1: cancelled, 0: pending, 1: partially filled, 2: fully filled, 4: cancel request in process
        switch (status) {
            case -1: return Models.OrderStatus.Cancelled;
            case 0: return Models.OrderStatus.Working;
            case 1: return Models.OrderStatus.Working;
            case 2: return Models.OrderStatus.Complete;
            case 4: return Models.OrderStatus.Working;
            default: return Models.OrderStatus.Other;
        }
    }

    private onTrade = (tsMsg : Models.Timestamped<KorbitTradeRecord>) => {
        var t = tsMsg.time;
        var msg : KorbitTradeRecord = tsMsg.data;
        var avgPx = parseFloat(msg.averagePrice);
        var lastQty = parseFloat(msg.sigTradeAmount);
        var lastPx = parseFloat(msg.sigTradePrice);

        var status : Models.OrderStatusUpdate = {
            exchangeId: msg.orderId.toString(),
            orderStatus: KorbitOrderEntryGateway.getStatus(msg.status),
            time: t,
            side: msg.tradeType.indexOf('buy')>-1 ? Models.Side.Bid : Models.Side.Ask,
            lastQuantity: lastQty > 0 ? lastQty : undefined,
            lastPrice: lastPx > 0 ? lastPx : undefined,
            averagePrice: avgPx > 0 ? avgPx : undefined,
            pendingCancel: msg.status === 4,
            partiallyFilled: msg.status === 1
        };

        this.OrderUpdate.trigger(status);
    };

    constructor(
            private _http: KorbitHttp,
            private _symbolProvider: KorbitSymbolProvider) {
        // _socket.setHandler("ok_sub_spot" + _symbolProvider.symbolQuote + "_trades", this.onTrade);
        // _socket.setHandler("ok_spot" + _symbolProvider.symbolQuote + "_trade", this.onOrderAck);
        // _socket.setHandler("ok_spot" + _symbolProvider.symbolQuote + "_cancel_order", this.onCancel);

        // _socket.ConnectChanged.on(cs => {
            // this.ConnectChanged.trigger(cs);

            // if (cs === Models.ConnectivityStatus.Connected) {
                // _socket.send("ok_sub_spot" + _symbolProvider.symbolQuote + "_trades");
            // }
        // });
    }
}

class KorbitMessageSigner {
    private _client_id : string;
    private _secretKey : string;
    private _user : string;
    private _pass : string;
    private _token : string;
    private _token_refresh : string;
    private _token_time : number = 0;

    private _refreshToken = (_http: KorbitHttp) : Promise<Models.Timestamped<TokenMessage>> => {
      var d = Promises.defer<Models.Timestamped<TokenMessage>>();
      _http.post("oauth2/access_token", {
        client_id: this._client_id,
        client_secret: this._secretKey,
        username: this._user,
        password: this._pass,
        grant_type: 'password'
      }, true).then(msg => {
        if ((<any>msg.data).access_token == "undefined")
          d.reject({msg:'Unable to get access_token'});
        d.resolve(msg);
      });
      return d.promise;
    };

    public signMessage = (_http: KorbitHttp, m : SignedMessage) : SignedMessage => {
        const now = new Date().getTime();
        if (this._token_time+3e+6<now) {
          const newToken: any = this._refreshToken(_http);
          this._token = newToken.data.access_token;
          this._token_refresh = newToken.data.refresh_token;
          this._token_time = now;
        }

        if (!m.hasOwnProperty("client_id"))
            m.client_id = this._client_id;
        if (!m.hasOwnProperty("client_secret"))
            m.client_secret = this._secretKey;
        if (!m.hasOwnProperty("code"))
            m.code = this._token;

        return this.toQueryString(m);
    };

    public toQueryString = (msg: SignedMessage) : string => {
        var els : string[] = [];
        var keys = [];
        for (var key in msg) {
            if (msg.hasOwnProperty(key))
                keys.push(key);
        }
        for (var i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (msg.hasOwnProperty(k))
                els.push(k + "=" + msg[k]);
        }

        return els.join("&");
    }

    constructor(config : Config.IConfigProvider) {
        this._client_id = config.GetString("KorbitApiKey");
        this._secretKey = config.GetString("KorbitSecretKey");
        this._user = config.GetString("KorbitUsername");
        this._pass = config.GetString("KorbitPassword");
    }
}

class KorbitHttp {
    post = <T>(actionUrl: string, msg : SignedMessage, publicApi?: boolean) : Promise<Models.Timestamped<T>> => {
        var d = Promises.defer<Models.Timestamped<T>>();

        request({
            url: url.resolve(this._baseUrl, actionUrl),
            body: querystring.stringify(publicApi ? this._signer.toQueryString(msg) : this._signer.signMessage(this, msg)),
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            method: "POST"
        }, (err, resp, body) => {
            if (err) d.reject(err);
            else {
                try {
                    var t = new Date();
                    var data = JSON.parse(body);
                    d.resolve(new Models.Timestamped(data, t));
                }
                catch (e) {
                    console.error(new Date().toISOString().slice(11, -1), 'korbit', err, 'url:', actionUrl, 'err:', err, 'body:', body);
                    d.reject(e);
                }
            }
        });

        return d.promise;
    };

    private _baseUrl : string;
    constructor(config : Config.IConfigProvider, private _signer: KorbitMessageSigner) {
        this._baseUrl = config.GetString("KorbitHttpUrl")
    }
}

class KorbitPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private trigger = () => {
        this._http.post("user/wallet", {currency_pair: this._symbolProvider.symbol}).then(msg => {
            if (!(<any>msg.data).result)
              console.error(new Date().toISOString().slice(11, -1), 'korbit', 'Please change the API Key or contact support team of Korbit, your API Key does not work because was not possible to retrieve your real wallet position; the application will probably crash now.');

            var free = (<any>msg.data).available;
            var freezed = (<any>msg.data).pendingOrders;
            var wallet = [];
            free.forEach(x => { wallet[x.currency] = [x.currency, x.value]; });
            freezed.forEach(x => { wallet[x.currency].push(x.value); });
            wallet.forEach(x => {
                var amount = parseFloat(free[x[1]]);
                var held = parseFloat(x[2]);

                var pos = new Models.CurrencyPosition(amount, held, Models.toCurrency(x[2]));
                this.PositionUpdate.trigger(pos);
            });
        });
    };

    constructor(
      private _http : KorbitHttp,
      private _symbolProvider: KorbitSymbolProvider
    ) {
        setInterval(this.trigger, 15000);
        setTimeout(this.trigger, 10);
    }
}

class KorbitBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name() : string {
        return "Korbit";
    }

    makeFee() : number {
        return 0.001;
    }

    takeFee() : number {
        return 0.002;
    }

    exchange() : Models.Exchange {
        return Models.Exchange.Korbit;
    }

    constructor(public minTickIncrement: number, public minSize: number) {}
}

class KorbitSymbolProvider {
    public symbol: string;
    public symbolReversed: string;
    public symbolQuote: string;

    constructor(pair: Models.CurrencyPair) {
        const GetCurrencySymbol = (s: Models.Currency) : string => Models.fromCurrency(s).toLowerCase();
        this.symbol = GetCurrencySymbol(pair.base) + "_" + GetCurrencySymbol(pair.quote);
        this.symbolReversed = GetCurrencySymbol(pair.quote) + "_" + GetCurrencySymbol(pair.base);
        this.symbolQuote = GetCurrencySymbol(pair.quote);
    }
}

class Korbit extends Interfaces.CombinedGateway {
    constructor(config : Config.IConfigProvider, pair: Models.CurrencyPair) {
        var symbol = new KorbitSymbolProvider(pair);
        var http = new KorbitHttp(config, new KorbitMessageSigner(config));

        var d = Promises.defer<Models.Timestamped<TokenMessage>>();
        http.post("constants", {}, true).then(msg => {
          if ((<any>msg.data).minTradableLevel == "undefined")
            d.reject({msg:'Unable to get mininum order'});
          d.resolve(msg);
        });
        const constants = d.promise;
        var minTick;
        for (var constant in constants)
          if (constant.toUpperCase()=='MIN'+pair.base+'ORDER') minTick = parseFloat(constants[constant]);
        minTick = minTick || 0.01;

        var orderGateway = config.GetString("KorbitOrderDestination") == "Korbit"
            ? <Interfaces.IOrderEntryGateway>new KorbitOrderEntryGateway(http, symbol)
            : new NullGateway.NullOrderGateway();

        super(
            new KorbitMarketDataGateway(http, symbol),
            orderGateway,
            new KorbitPositionGateway(http, symbol),
            new KorbitBaseGateway(minTick, minTick)
        );
        }
}
export async function createKorbit(config : Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    return new Korbit(config, pair);
}
