/**
 * Conservative paper execution model. See docs/EXECUTION_MODEL.md.
 *
 * - Orders are post-only limit orders. An order that would cross the book when it goes live is rejected.
 * - Placement latency: submitted at t, live at t + orderLatencyMs. Trades before that cannot fill it.
 * - Cancel latency: requested at t, effective at max(t + cancelLatencyMs, liveAt). Trades before that can fill it.
 * - Queue position is unknown from L2 data, so we assume BACK OF QUEUE: queueAhead = displayed size at our
 *   price level in the latest book at live time (0 if the level does not exist). queueAhead only decreases
 *   through trades printed at our price; book snapshots never reduce it (we cannot tell cancels ahead of us
 *   from cancels behind us).
 * - A fill requires a printed trade at our price (after queueAhead is exhausted) or through our price.
 *   A book touch never fills. A fill is never larger than the printed trade size.
 * - Tie rule: a trade and a cancel at the same millisecond -> the fill wins (scheduler priority order).
 */
import { type Decimal, feeOn, fmtMoney, fmtPrice, fmtQty, minBig, notional } from '../core/money.js';
import { Priority, type Scheduler } from '../core/scheduler.js';
import type { BookEvent, TradeEvent } from '../market/events.js';

export interface ExecutionConfig {
  orderLatencyMs: number;
  cancelLatencyMs: number;
  makerFeeBps: bigint;
  /** Fixed cost charged on every order submission (MONEY_SCALE). Models gas / tx fees. */
  placementCost: bigint;
  /** Fixed cost charged on every cancel request (MONEY_SCALE). */
  cancelCost: bigint;
  tickSize: bigint;
  lotSize: bigint;
}

export interface ExecutionConfigWire {
  orderLatencyMs: number;
  cancelLatencyMs: number;
  makerFeeBps: string;
  placementCost: Decimal;
  cancelCost: Decimal;
  tickSize: Decimal;
  lotSize: Decimal;
  queueModel: string;
  tieRule: string;
}

export function executionConfigToWire(c: ExecutionConfig): ExecutionConfigWire {
  return {
    orderLatencyMs: c.orderLatencyMs,
    cancelLatencyMs: c.cancelLatencyMs,
    makerFeeBps: c.makerFeeBps.toString(),
    placementCost: fmtMoney(c.placementCost),
    cancelCost: fmtMoney(c.cancelCost),
    tickSize: fmtPrice(c.tickSize),
    lotSize: fmtQty(c.lotSize),
    queueModel: QUEUE_MODEL,
    tieRule: TIE_RULE,
  };
}

export const QUEUE_MODEL = 'pessimistic_back_of_queue: queueAhead = displayed level size at live time; reduced only by trades at our price';
export const TIE_RULE = 'same-millisecond trade vs cancel-effective: fill wins (market events precede exchange transitions)';
export const FILL_UNCERTAINTY_NOTE =
  'Queue position is inferred from L2 snapshots, not observed. Real fills may occur earlier (if the level ahead thins by cancels) or never (hidden liquidity, self-match rules, latency spikes).';

export const EXECUTION_ASSUMPTIONS: readonly string[] = [
  'Post-only limit orders; an order that would cross the book at live time is rejected, never filled as a taker.',
  'Order placement latency and cancel latency are fixed constants applied in simulated time.',
  QUEUE_MODEL,
  'A fill requires a printed trade at or through the order price; a book touch never fills.',
  'A fill is never larger than the printed trade size, even on trade-through.',
  'Trades whose aggressor is on the same side as our order (e.g. a buy print at or below our bid) are ignored.',
  TIE_RULE,
  'Maker fee in bps rounded up; fixed placement and cancel costs charged at request time whether or not the order later fills.',
  'Our own orders are not part of the replayed book; the replayed market is not impacted by our activity.',
  'Fill notifications are assumed instantaneous (the portfolio updates at the trade obsTime).',
];

import type { Side } from '../core/side.js';
export type OrderState = 'pending' | 'live' | 'cancel_pending' | 'filled' | 'cancelled' | 'rejected';

export interface NewOrder {
  clientId: string;
  side: Side;
  price: bigint;
  qty: bigint;
}

export interface PaperOrder {
  orderId: string;
  clientId: string;
  side: Side;
  price: bigint;
  qty: bigint;
  filledQty: bigint;
  state: OrderState;
  /** True once the venue has acknowledged the order (liveAt reached). Only live orders can fill. */
  isLive: boolean;
  submittedAt: number;
  liveAt: number;
  queueAhead: bigint;
  queueBookEventId: string | null;
  cancelRequestedAt: number | null;
  cancelEffectiveAt: number | null;
}

export type ExecutionEvent =
  | { kind: 'order_submitted'; order: PaperOrder; cost: bigint; at: number }
  | { kind: 'order_live'; order: PaperOrder; at: number }
  | { kind: 'order_rejected'; order: PaperOrder; reason: 'post_only_would_cross' | 'no_book'; detail: string; at: number }
  | { kind: 'cancel_requested'; order: PaperOrder; cost: bigint; at: number; effectiveAt: number; reason: string }
  | { kind: 'cancel_effective'; order: PaperOrder; at: number }
  | { kind: 'cancel_too_late'; order: PaperOrder; at: number; reason: 'already_filled' | 'already_cancelled' | 'already_rejected' }
  | { kind: 'cancel_fill_race'; order: PaperOrder; trade: TradeEvent; at: number }
  | {
      kind: 'fill';
      order: PaperOrder;
      trade: TradeEvent;
      qty: bigint;
      notional: bigint;
      fee: bigint;
      fillType: 'trade_through' | 'queue_exhausted';
      queueAheadBefore: bigint;
      duringCancelPending: boolean;
      at: number;
    }
  | { kind: 'queue_consumed'; order: PaperOrder; trade: TradeEvent; queueAheadBefore: bigint; at: number };

export class PaperExchange {
  private readonly orders = new Map<string, PaperOrder>();
  private nextId = 1;

  constructor(
    readonly config: ExecutionConfig,
    private readonly scheduler: Scheduler,
    private readonly emit: (ev: ExecutionEvent) => void,
    private readonly latestBook: () => BookEvent | null,
  ) {}

  submit(req: NewOrder, now: number): PaperOrder {
    const order: PaperOrder = {
      orderId: `o${this.nextId++}`,
      clientId: req.clientId,
      side: req.side,
      price: req.price,
      qty: req.qty,
      filledQty: 0n,
      state: 'pending',
      isLive: false,
      submittedAt: now,
      liveAt: now + this.config.orderLatencyMs,
      queueAhead: 0n,
      queueBookEventId: null,
      cancelRequestedAt: null,
      cancelEffectiveAt: null,
    };
    this.orders.set(order.orderId, order);
    this.emit({ kind: 'order_submitted', order, cost: this.config.placementCost, at: now });
    this.scheduler.schedule(order.liveAt, Priority.EXCHANGE, () => this.goLive(order));
    return order;
  }

  requestCancel(orderId: string, now: number, reason: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.state === 'filled' || order.state === 'cancelled' || order.state === 'rejected' || order.state === 'cancel_pending') {
      return false;
    }
    order.cancelRequestedAt = now;
    order.cancelEffectiveAt = Math.max(now + this.config.cancelLatencyMs, order.liveAt);
    order.state = 'cancel_pending';
    this.emit({ kind: 'cancel_requested', order, cost: this.config.cancelCost, at: now, effectiveAt: order.cancelEffectiveAt, reason });
    this.scheduler.schedule(order.cancelEffectiveAt, Priority.EXCHANGE, () => this.applyCancel(order));
    return true;
  }

  openOrders(): PaperOrder[] {
    return [...this.orders.values()].filter((o) => o.state === 'pending' || o.state === 'live' || o.state === 'cancel_pending');
  }

  /** Open orders on a side that are not already being cancelled. */
  restingOn(side: Side): PaperOrder[] {
    return this.openOrders().filter((o) => o.side === side && o.state !== 'cancel_pending');
  }

  get(orderId: string): PaperOrder | undefined {
    return this.orders.get(orderId);
  }

  onTrade(trade: TradeEvent, now: number): void {
    let available = trade.size;
    // Price-time priority among our own orders: better price first, then earlier live time.
    const candidates = this.openOrders()
      .filter((o) => o.isLive && (o.state === 'live' || o.state === 'cancel_pending'))
      .filter((o) => this.isRelevant(o, trade))
      .sort((a, b) => {
        if (a.price !== b.price) return a.side === 'buy' ? (a.price > b.price ? -1 : 1) : a.price < b.price ? -1 : 1;
        return a.liveAt - b.liveAt;
      });
    for (const order of candidates) {
      if (available <= 0n) break;
      const remaining = order.qty - order.filledQty;
      const through = order.side === 'buy' ? trade.price < order.price : trade.price > order.price;
      const queueAheadBefore = order.queueAhead;
      let fillQty = 0n;
      let fillType: 'trade_through' | 'queue_exhausted' = 'queue_exhausted';
      if (through) {
        order.queueAhead = 0n;
        fillQty = minBig(remaining, available);
        fillType = 'trade_through';
      } else if (available <= order.queueAhead) {
        order.queueAhead -= available;
        this.emit({ kind: 'queue_consumed', order, trade, queueAheadBefore, at: now });
        available = 0n;
        continue;
      } else {
        const excess = available - order.queueAhead;
        order.queueAhead = 0n;
        fillQty = minBig(remaining, excess);
      }
      if (fillQty <= 0n) continue;
      available -= fillQty;
      const n = notional(order.price, fillQty);
      const fee = feeOn(n, this.config.makerFeeBps);
      const duringCancelPending = order.state === 'cancel_pending';
      order.filledQty += fillQty;
      if (order.filledQty === order.qty) order.state = 'filled';
      if (duringCancelPending) this.emit({ kind: 'cancel_fill_race', order, trade, at: now });
      this.emit({ kind: 'fill', order, trade, qty: fillQty, notional: n, fee, fillType, queueAheadBefore, duringCancelPending, at: now });
    }
  }

  private isRelevant(order: PaperOrder, trade: TradeEvent): boolean {
    if (order.side === 'buy') {
      return trade.price <= order.price && trade.aggressor !== 'buy';
    }
    return trade.price >= order.price && trade.aggressor !== 'sell';
  }

  private goLive(order: PaperOrder): void {
    if (order.state !== 'pending' && order.state !== 'cancel_pending') return;
    const book = this.latestBook();
    const at = order.liveAt;
    if (!book) {
      order.state = 'rejected';
      this.emit({ kind: 'order_rejected', order, reason: 'no_book', detail: 'no valid book at live time', at });
      return;
    }
    const bb = book.bids[0];
    const ba = book.asks[0];
    if ((order.side === 'buy' && ba && order.price >= ba.price) || (order.side === 'sell' && bb && order.price <= bb.price)) {
      order.state = 'rejected';
      this.emit({
        kind: 'order_rejected',
        order,
        reason: 'post_only_would_cross',
        detail: `${order.side} @ ${fmtPrice(order.price)} would cross book ${bb ? fmtPrice(bb.price) : '-'} / ${ba ? fmtPrice(ba.price) : '-'}`,
        at,
      });
      return;
    }
    const levels = order.side === 'buy' ? book.bids : book.asks;
    const level = levels.find((l) => l.price === order.price);
    order.queueAhead = level ? level.size : 0n;
    order.queueBookEventId = book.eventId;
    order.isLive = true;
    if (order.state === 'pending') order.state = 'live';
    this.emit({ kind: 'order_live', order, at });
  }

  private applyCancel(order: PaperOrder): void {
    const at = order.cancelEffectiveAt ?? 0;
    if (order.state === 'cancel_pending') {
      order.state = 'cancelled';
      this.emit({ kind: 'cancel_effective', order, at });
      return;
    }
    const reason = order.state === 'filled' ? 'already_filled' : order.state === 'rejected' ? 'already_rejected' : 'already_cancelled';
    this.emit({ kind: 'cancel_too_late', order, at, reason });
  }
}

export function remainingQty(o: PaperOrder): bigint {
  return o.qty - o.filledQty;
}

export function openExposure(orders: PaperOrder[]): { openBuyQty: bigint; openSellQty: bigint } {
  let openBuyQty = 0n;
  let openSellQty = 0n;
  for (const o of orders) {
    const r = remainingQty(o);
    if (o.side === 'buy') openBuyQty += r;
    else openSellQty += r;
  }
  return { openBuyQty, openSellQty };
}

