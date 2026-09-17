/**
 * Conservative paper execution model. See docs/EXECUTION_MODEL.md.
 *
 * TIME SEMANTICS
 *   Two clocks touch every trade: the venue clock (`marketTime`, when the print happened on the book)
 *   and the observation clock (`obsTime`, when the strategy learned about it). Orders live on the venue
 *   clock: `liveAt` and `cancelEffectiveAt` are venue instants (submission or request time plus modeled
 *   latency, on the same time base as marketTime). Matching happens when a trade is OBSERVED, but
 *   eligibility is decided on VENUE time:
 *
 *     eligible  <=>  liveAt < trade.marketTime <= cancelEffectiveAt (if a cancel was requested)
 *
 *   - marketTime <  liveAt             : the print predates activation -> no fill (`fill_ineligible`)
 *   - marketTime == liveAt             : ordering unknown at ms resolution -> no fill, recorded as uncertainty
 *   - marketTime >  cancelEffectiveAt  : the order was already gone -> no fill
 *   - marketTime == cancelEffectiveAt  : the fill wins the tie (adverse for a quoter pulling its quote)
 *   - marketTime in window but observed after cancelEffectiveAt: a LATE FILL; the cancel was in reality
 *     rejected for that quantity and the strategy learns at obsTime (`cancel_fill_race` + `fill`).
 *   A provisionally cancelled order stays matchable for late trades until `cancelEffectiveAt +
 *   maxTradeLagMs`; a qualifying trade observed after that is `fill_uncertain`, never awarded.
 *
 * FILL RULES
 * - Orders are post-only limit orders. An order that would cross the book when it goes live is rejected.
 * - Queue position is unknown from L2 data, so we assume BACK OF QUEUE: queueAhead = displayed size at our
 *   price level in the latest observed book at live time (0 if the level does not exist). queueAhead only
 *   decreases through eligible trades printed at our price; book snapshots never reduce it.
 * - A fill requires a printed trade at our price (after queueAhead is exhausted) or through our price.
 *   A book touch never fills. A fill is never larger than the printed trade size.
 */
import { type Decimal, feeOn, fmtMoney, fmtPrice, fmtQty, minBig, notional } from '../core/money.js';
import { Priority, type Scheduler } from '../core/scheduler.js';
import type { Side } from '../core/side.js';
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
  eligibilityRule: string;
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
    eligibilityRule: ELIGIBILITY_RULE,
  };
}

export const QUEUE_MODEL =
  'pessimistic_back_of_queue: queueAhead = displayed level size in the latest observed book at live time; reduced only by eligible trades at our price';
export const ELIGIBILITY_RULE =
  'venue-time eligibility: a trade fills an order only if liveAt < trade.marketTime <= cancelEffectiveAt; matching happens at trade obsTime';
export const TIE_RULE =
  'ties: trade.marketTime == liveAt -> no fill (recorded as uncertainty); trade.marketTime == cancelEffectiveAt -> fill wins';
export const FILL_UNCERTAINTY_NOTE =
  'Queue position is inferred from L2 snapshots, not observed. Real fills may occur earlier (if the level ahead thins by cancels) or never (hidden liquidity, self-match rules, latency spikes).';

export const EXECUTION_ASSUMPTIONS: readonly string[] = [
  'Post-only limit orders; an order that would cross the observed book at live time is rejected, never filled as a taker.',
  'Order placement latency and cancel latency are fixed constants; liveAt and cancelEffectiveAt are venue-clock instants on the same time base as marketTime.',
  ELIGIBILITY_RULE,
  'A trade observed after the order was live but printed (marketTime) before liveAt cannot fill it; it is logged as fill_ineligible.',
  'A trade printed while the order was live but observed after its cancel took effect is a late fill: the cancel is treated as rejected for that quantity and the strategy learns at obsTime.',
  'A provisionally cancelled order stays matchable for late trades for maxTradeLagMs after cancelEffectiveAt; a qualifying trade observed later is logged as fill_uncertain and not awarded.',
  QUEUE_MODEL,
  'A fill requires a printed trade at or through the order price; a book touch never fills.',
  'A fill is never larger than the printed trade size, even on trade-through.',
  'Trades whose aggressor is on the same side as our order (e.g. a buy print at or below our bid) are ignored.',
  TIE_RULE,
  'Maker fee in bps rounded up; fixed placement and cancel costs charged at request time whether or not the order later fills.',
  'Our own orders are not part of the replayed book; the replayed market is not impacted by our activity.',
  'Fill notifications are assumed to arrive with the trade observation (the portfolio updates at the trade obsTime).',
  'The queue estimate at live time uses the latest OBSERVED book, whose venue time may precede liveAt by the feed lag.',
];

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
  /** Quantity filled by trades observed after the cancel took effect (subset of filledQty). */
  lateFilledQty: bigint;
  state: OrderState;
  /** True once the venue has acknowledged the order (liveAt reached on the sim clock). */
  isLive: boolean;
  submittedAt: number;
  /** Venue time the order rests on the book. */
  liveAt: number;
  queueAhead: bigint;
  queueBookEventId: string | null;
  queueBookMarketTime: number | null;
  cancelRequestedAt: number | null;
  /** Venue time the order leaves the book, once a cancel is requested. */
  cancelEffectiveAt: number | null;
  /** Sim time after which no late trade can be matched to this order (cancelEffectiveAt + maxTradeLagMs). */
  finalAt: number | null;
}

export type IneligibleReason = 'predates_activation' | 'at_activation_instant' | 'after_cancellation';
export type RaceOutcome = 'fill_wins_before_cancel' | 'fill_wins_tie' | 'late_fill_after_cancel_effective';

export type ExecutionEvent =
  | { kind: 'order_submitted'; order: PaperOrder; cost: bigint; at: number }
  | { kind: 'order_live'; order: PaperOrder; at: number; book: BookEvent }
  | { kind: 'order_rejected'; order: PaperOrder; reason: 'post_only_would_cross' | 'no_book'; detail: string; at: number }
  | { kind: 'cancel_requested'; order: PaperOrder; cost: bigint; at: number; effectiveAt: number; reason: string }
  | { kind: 'cancel_effective'; order: PaperOrder; at: number; finalAt: number }
  | { kind: 'cancel_too_late'; order: PaperOrder; at: number; reason: 'already_filled' | 'already_cancelled' | 'already_rejected' }
  | { kind: 'cancel_fill_race'; order: PaperOrder; trade: TradeEvent; at: number; outcome: RaceOutcome }
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
      afterCancelEffective: boolean;
      at: number;
    }
  | { kind: 'queue_consumed'; order: PaperOrder; trade: TradeEvent; queueAheadBefore: bigint; at: number }
  | { kind: 'fill_ineligible'; order: PaperOrder; trade: TradeEvent; reason: IneligibleReason; at: number }
  | { kind: 'fill_uncertain'; order: PaperOrder; trade: TradeEvent; reason: 'observed_after_finalization'; at: number };

export interface PaperExchangeOptions {
  /**
   * Maximum (obsTime - marketTime) lag of a trade that can still be matched against a cancelled order.
   * The engine sets this to its observation staleness limit, so anything later would have been rejected
   * as stale before reaching the exchange.
   */
  maxTradeLagMs: number;
}

export class PaperExchange {
  private readonly orders = new Map<string, PaperOrder>();
  private nextId = 1;
  private readonly maxTradeLagMs: number;

  constructor(
    readonly config: ExecutionConfig,
    private readonly scheduler: Scheduler,
    private readonly emit: (ev: ExecutionEvent) => void,
    private readonly latestBook: () => BookEvent | null,
    options: PaperExchangeOptions,
  ) {
    if (!Number.isInteger(options.maxTradeLagMs) || options.maxTradeLagMs < 0) {
      throw new RangeError('maxTradeLagMs must be a non-negative integer');
    }
    this.maxTradeLagMs = options.maxTradeLagMs;
  }

  submit(req: NewOrder, now: number): PaperOrder {
    const order: PaperOrder = {
      orderId: `o${this.nextId++}`,
      clientId: req.clientId,
      side: req.side,
      price: req.price,
      qty: req.qty,
      filledQty: 0n,
      lateFilledQty: 0n,
      state: 'pending',
      isLive: false,
      submittedAt: now,
      liveAt: now + this.config.orderLatencyMs,
      queueAhead: 0n,
      queueBookEventId: null,
      queueBookMarketTime: null,
      cancelRequestedAt: null,
      cancelEffectiveAt: null,
      finalAt: null,
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

  /** Orders the strategy considers open: not yet acknowledged, resting, or with a cancel in flight. */
  openOrders(): PaperOrder[] {
    return [...this.orders.values()].filter((o) => o.state === 'pending' || o.state === 'live' || o.state === 'cancel_pending');
  }

  /** Open orders on a side that are not already being cancelled. */
  restingOn(side: Side): PaperOrder[] {
    return this.openOrders().filter((o) => o.side === side && o.state !== 'cancel_pending');
  }

  /** Cancelled orders that can still receive a late fill (cancel took effect, finalization not reached). */
  provisionallyCancelled(now: number): PaperOrder[] {
    return [...this.orders.values()].filter((o) => o.state === 'cancelled' && o.finalAt !== null && now <= o.finalAt && o.filledQty < o.qty);
  }

  get(orderId: string): PaperOrder | undefined {
    return this.orders.get(orderId);
  }

  /**
   * Match an observed trade. `now` is the observation time; eligibility uses trade.marketTime.
   *
   * Which orders are evaluated: resting orders and orders with a cancel in flight always; cancelled
   * orders only while provisional (now <= finalAt), so a dead order is not re-evaluated against every
   * later print. The one exception is a trade whose own observation lag exceeds maxTradeLagMs: it may
   * be eligible for an already finalized order, which is the `fill_uncertain` case and must be recorded.
   */
  onTrade(trade: TradeEvent, now: number): void {
    let available = trade.size;
    const overLagged = trade.obsTime - trade.marketTime > this.maxTradeLagMs;
    // Price-time priority among our own orders: better price first, then earlier live time.
    const candidates = [...this.orders.values()]
      .filter((o) => o.isLive && o.filledQty < o.qty)
      .filter((o) => o.state === 'live' || o.state === 'cancel_pending' || (o.state === 'cancelled' && (now <= (o.finalAt ?? -1) || overLagged)))
      .filter((o) => this.isPriceRelevant(o, trade))
      .sort((a, b) => {
        if (a.price !== b.price) return a.side === 'buy' ? (a.price > b.price ? -1 : 1) : a.price < b.price ? -1 : 1;
        return a.liveAt - b.liveAt;
      });
    for (const order of candidates) {
      if (available <= 0n) break;

      // ---- venue-time eligibility -------------------------------------------------------------
      const finalized = order.state === 'cancelled' && order.finalAt !== null && now > order.finalAt;
      if (trade.marketTime < order.liveAt) {
        if (!finalized) this.emit({ kind: 'fill_ineligible', order, trade, reason: 'predates_activation', at: now });
        continue;
      }
      if (trade.marketTime === order.liveAt) {
        if (!finalized) this.emit({ kind: 'fill_ineligible', order, trade, reason: 'at_activation_instant', at: now });
        continue;
      }
      if (order.cancelEffectiveAt !== null && trade.marketTime > order.cancelEffectiveAt) {
        if (!finalized) this.emit({ kind: 'fill_ineligible', order, trade, reason: 'after_cancellation', at: now });
        continue;
      }
      if (finalized) {
        // Eligible on venue time, but the order was finalized before the print was observed.
        this.emit({ kind: 'fill_uncertain', order, trade, reason: 'observed_after_finalization', at: now });
        continue;
      }

      // ---- queue / price logic -----------------------------------------------------------------
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
      const afterCancelEffective = order.state === 'cancelled';
      order.filledQty += fillQty;
      if (afterCancelEffective) {
        order.lateFilledQty += fillQty;
        this.emit({ kind: 'cancel_fill_race', order, trade, at: now, outcome: 'late_fill_after_cancel_effective' });
      } else {
        if (order.filledQty === order.qty) order.state = 'filled';
        if (duringCancelPending) {
          const outcome: RaceOutcome = trade.marketTime === order.cancelEffectiveAt ? 'fill_wins_tie' : 'fill_wins_before_cancel';
          this.emit({ kind: 'cancel_fill_race', order, trade, at: now, outcome });
        }
      }
      this.emit({
        kind: 'fill',
        order,
        trade,
        qty: fillQty,
        notional: n,
        fee,
        fillType,
        queueAheadBefore,
        duringCancelPending,
        afterCancelEffective,
        at: now,
      });
    }
  }

  private isPriceRelevant(order: PaperOrder, trade: TradeEvent): boolean {
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
      this.emit({ kind: 'order_rejected', order, reason: 'no_book', detail: 'no valid book observed by live time', at });
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
        detail: `${order.side} @ ${fmtPrice(order.price)} would cross observed book ${bb ? fmtPrice(bb.price) : '-'} / ${ba ? fmtPrice(ba.price) : '-'}`,
        at,
      });
      return;
    }
    const levels = order.side === 'buy' ? book.bids : book.asks;
    const level = levels.find((l) => l.price === order.price);
    order.queueAhead = level ? level.size : 0n;
    order.queueBookEventId = book.eventId;
    order.queueBookMarketTime = book.marketTime;
    order.isLive = true;
    if (order.state === 'pending') order.state = 'live';
    this.emit({ kind: 'order_live', order, at, book });
  }

  private applyCancel(order: PaperOrder): void {
    const at = order.cancelEffectiveAt ?? 0;
    if (order.state === 'cancel_pending') {
      order.state = 'cancelled';
      order.finalAt = at + this.maxTradeLagMs;
      this.emit({ kind: 'cancel_effective', order, at, finalAt: order.finalAt });
      return;
    }
    const reason = order.state === 'filled' ? 'already_filled' : order.state === 'rejected' ? 'already_rejected' : 'already_cancelled';
    this.emit({ kind: 'cancel_too_late', order, at, reason });
  }
}

export function remainingQty(o: PaperOrder): bigint {
  return o.qty - o.filledQty;
}

/** Exposure the risk gate charges: orders the strategy considers open (pending, live, cancel in flight). */
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
