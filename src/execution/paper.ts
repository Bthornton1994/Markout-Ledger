/**
 * Conservative paper execution model. See docs/EXECUTION_MODEL.md.
 *
 * TIME SEMANTICS
 *   Two clocks touch every trade: the venue clock (`marketTime`, when the print happened on the book)
 *   and the observation clock (`obsTime`, when the strategy learned about it). Orders live on the venue
 *   clock: `liveAt` and `cancelEffectiveAt` are venue instants (submission or request time plus modeled
 *   latency, on the same time base as marketTime). A print is eligible for an order iff
 *
 *     liveAt < trade.marketTime <= cancelEffectiveAt      (cancelEffectiveAt = +inf while no cancel is requested)
 *
 * VENUE-ORDERED MATCHING WITH A BOUNDED REORDERING WINDOW
 *   Prints may be observed out of venue order. Queue matching is therefore never applied in arrival
 *   order. Instead, per side, the exchange keeps every eligible print whose venue time is inside the
 *   reordering window (marketTime >= now - maxTradeLagMs) in venue order, and on each arrival re-runs the
 *   matching from a checkpoint over that window. The venue-ordered fill total F(known prints) is
 *   monotone in the set of known prints (an extra print can only advance our queue position or hit us),
 *   so the exchange awards `F(known now) - awarded so far` at the observation time of the arriving print.
 *   Awards are therefore always supported by the prints actually observed, never revised downward, and
 *   the strategy learns of a fill only when the print that establishes it has been observed. Once the
 *   window moves past a print (marketTime < now - maxTradeLagMs) no later-observed print can precede it
 *   (it would exceed the lag bound), so the prefix is folded into the orders' checkpoints and is final.
 *
 * PROVENANCE
 *   Quantity is booked per SOURCE print: the print that fills the order in venue order. Each fill event
 *   names its source print (whose size bounds it) and venue time, and the print whose observation
 *   established it (`establishedBy`, which may be a different, later-observed earlier print). When a
 *   later-observed earlier print changes how already-booked quantity splits across sources, the booking
 *   is not undone (accounting is unchanged); a `fill_reattributed` event moves the provenance of that
 *   quantity to its actual source print so the ledger always carries the venue-order attribution.
 *
 *   The engine discards observations lagging more than the same bound (stale). A discarded print that
 *   was eligible for one of our orders is reported through `noteDiscardedTrade` as `fill_uncertain`:
 *   the data cannot establish whether it filled us, so nothing is awarded and the doubt is recorded.
 *
 * FILL RULES
 * - Orders are post-only limit orders. An order that would cross the book when it goes live is rejected.
 * - Queue position is unknown from L2 data, so we assume BACK OF QUEUE. Each price level we rest on is one
 *   FIFO: [level queue][own order 1][between 2][own order 2]... The LEVEL QUEUE is the displayed size at the
 *   level when the first own order went live; a later own order at the same level sits behind the own orders
 *   already there and behind its BETWEEN segment, max(0, displayed at its live time - current level queue),
 *   the growth of the level since the queue was captured. Queues only decrease through eligible prints at
 *   that price; book snapshots never reduce them. This keeps time priority among our own orders and makes
 *   every order's venue-ordered fill total monotone in the set of known prints.
 * - A fill requires a printed trade at our price (after the queue ahead is exhausted) or through our price.
 *   A book touch never fills. A fill is never larger than the printed trade size.
 */
import { type Decimal, feeOn, fmtMoney, fmtPrice, fmtQty, maxBig, minBig, notional } from '../core/money.js';
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
  matchingModel: string;
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
    matchingModel: MATCHING_MODEL,
    tieRule: TIE_RULE,
    eligibilityRule: ELIGIBILITY_RULE,
  };
}

export const QUEUE_MODEL =
  'pessimistic_back_of_queue: each price level is one FIFO; level queue = displayed size when the first own order went live, later own orders sit behind earlier own orders plus the level growth since; queues are reduced only by eligible prints at that price';
export const MATCHING_MODEL =
  'venue_ordered_bounded_window: prints are matched in venue-time order within a window of maxTradeLagMs; fills are awarded incrementally as the venue-ordered total grows, at the observation time of the print that establishes them';
export const ELIGIBILITY_RULE =
  'venue-time eligibility: a print can fill an order only if liveAt < trade.marketTime <= cancelEffectiveAt';
export const TIE_RULE =
  'ties: trade.marketTime == liveAt -> no fill (recorded as ineligible); trade.marketTime == cancelEffectiveAt -> fill wins';
export const FILL_UNCERTAINTY_NOTE =
  'Queue position is inferred from L2 snapshots, not observed. Real fills may occur earlier (if the level ahead thins by cancels) or never (hidden liquidity, self-match rules, latency spikes).';

export const EXECUTION_ASSUMPTIONS: readonly string[] = [
  'Post-only limit orders; an order that would cross the observed book at live time is rejected, never filled as a taker.',
  'Order placement latency and cancel latency are fixed constants (zero allowed); liveAt and cancelEffectiveAt are venue-clock instants on the same time base as marketTime.',
  ELIGIBILITY_RULE,
  MATCHING_MODEL,
  'A print observed after the order was live but printed (marketTime) before liveAt cannot fill it; it is logged as fill_ineligible.',
  'A print made while the order was live but observed after its cancel took effect is a late fill: the cancel is treated as rejected for that quantity and the strategy learns at obsTime.',
  'A cancelled order stays provisional for maxTradeLagMs after cancelEffectiveAt (no later-observed print can precede its cancel after that).',
  'A print the engine discards as stale (lag beyond maxTradeLagMs) that was eligible for one of our orders is logged as fill_uncertain: nothing is awarded and the doubt is recorded.',
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
  /** Quantity awarded (booked) so far: the venue-ordered fill total over the prints known at the last recompute. */
  filledQty: bigint;
  /** Quantity awarded by prints observed after the cancel took effect (subset of filledQty). */
  lateFilledQty: bigint;
  state: OrderState;
  /** True once the venue has acknowledged the order (liveAt reached on the sim clock). */
  isLive: boolean;
  submittedAt: number;
  /** Venue time the order rests on the book. */
  liveAt: number;
  /** Displayed size at our level in the latest observed book when we went live (raw estimate). */
  displayedAtLive: bigint;
  /** Level queue (external volume ahead of the first own order at this level) when we went live. */
  levelQueueAtLive: bigint;
  /** Own orders already resting at this level when we went live. */
  ownOrdersAheadAtLive: number;
  /** Our BETWEEN segment when we went live: level growth behind the own orders ahead of us. */
  betweenQueueInitial: bigint;
  /** Current between segment after the latest venue-ordered recompute. */
  betweenQueue: bigint;
  /** Effective external volume ahead of us after the latest recompute: level queue + between segment. */
  queueAhead: bigint;
  queueBookEventId: string | null;
  queueBookMarketTime: number | null;
  cancelRequestedAt: number | null;
  /** Venue time the order leaves the book, once a cancel is requested. */
  cancelEffectiveAt: number | null;
  /** Sim time after which no late print can be matched to this order (cancelEffectiveAt + maxTradeLagMs). */
  finalAt: number | null;
  /** Matching checkpoint: between segment and filled quantity after every print with venue time below the side's fold cut. */
  ckptBetweenQueue: bigint;
  ckptFilled: bigint;
  /** Booked quantity per source print (the print that filled us in venue order). Values sum to filledQty. */
  awardedBySource: Map<string, { trade: TradeEvent; qty: bigint }>;
}

export type IneligibleReason = 'predates_activation' | 'at_activation_instant' | 'after_cancellation';
export type RaceOutcome = 'fill_wins_before_cancel' | 'fill_wins_tie' | 'late_fill_after_cancel_effective';
export type FillType = 'trade_through' | 'queue_exhausted';

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
      /** The print that filled us in venue order; its size bounds the fill. */
      sourceTrade: TradeEvent;
      /** The print whose observation established this fill (equals sourceTrade unless re-ordering released it). */
      establishedBy: TradeEvent;
      qty: bigint;
      notional: bigint;
      fee: bigint;
      fillType: FillType;
      queueAheadBefore: bigint;
      duringCancelPending: boolean;
      afterCancelEffective: boolean;
      at: number;
    }
  | {
      /** Already-booked quantity whose venue-order source changed: provenance moves, accounting does not. */
      kind: 'fill_reattributed';
      order: PaperOrder;
      fromTrade: TradeEvent;
      toTrade: TradeEvent;
      qty: bigint;
      establishedBy: TradeEvent;
      at: number;
    }
  | { kind: 'queue_consumed'; order: PaperOrder; trade: TradeEvent; queueAheadBefore: bigint; queueAheadAfter: bigint; at: number }
  | { kind: 'fill_ineligible'; order: PaperOrder; trade: TradeEvent; reason: IneligibleReason; at: number }
  | { kind: 'fill_uncertain'; order: PaperOrder; trade: TradeEvent; reason: 'stale_print_discarded'; at: number };

export interface PaperExchangeOptions {
  /**
   * Bound on (obsTime - marketTime) for prints fed to `onTrade`; also the reordering window and the
   * provisional period of a cancelled order. The engine sets it to its observation staleness limit and
   * routes prints beyond it to `noteDiscardedTrade`.
   */
  maxTradeLagMs: number;
}

interface SideMatcher {
  /** Eligible prints inside the reordering window, in venue order. */
  trades: TradeEvent[];
  /** Every print with marketTime < cut has been folded into the orders' checkpoints. */
  cut: number;
}

interface SimState {
  betweenQueue: bigint;
  filled: bigint;
}

interface LevelState {
  /** External volume ahead of the first own order at this level, after every folded print. */
  ckptQueueAhead: bigint;
  /** ...after the latest recompute over the window prints. */
  queueAhead: bigint;
}

interface Role {
  kind: 'through' | 'queue_exhausted' | 'queue_consumed';
  queueBefore: bigint;
  queueAfter: bigint;
  fill: bigint;
}

interface SimResult {
  states: Map<string, SimState>;
  /** Level queue after the simulated prints, keyed by level. */
  levels: Map<string, bigint>;
  /** roles.get(tradeEventId).get(orderId) */
  roles: Map<string, Map<string, Role>>;
}

function levelKey(side: Side, price: bigint): string {
  return `${side}@${price}`;
}

export class PaperExchange {
  private readonly orders = new Map<string, PaperOrder>();
  private readonly sides: Record<Side, SideMatcher> = {
    buy: { trades: [], cut: Number.NEGATIVE_INFINITY },
    sell: { trades: [], cut: Number.NEGATIVE_INFINITY },
  };
  private readonly levels = new Map<string, LevelState>();
  private nextId = 1;
  private readonly maxTradeLagMs: number;
  /** True while onTrade is matching; cancels requested meanwhile are applied after the matching loop. */
  private matching = false;
  private readonly deferredCancels: PaperOrder[] = [];

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
    for (const key of ['orderLatencyMs', 'cancelLatencyMs'] as const) {
      if (!Number.isInteger(config[key]) || config[key] < 0) throw new RangeError(`${key} must be a non-negative integer (zero is allowed)`);
    }
    this.maxTradeLagMs = options.maxTradeLagMs;
  }

  // ------------------------------------------------------------------ orders

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
      displayedAtLive: 0n,
      levelQueueAtLive: 0n,
      ownOrdersAheadAtLive: 0,
      betweenQueueInitial: 0n,
      betweenQueue: 0n,
      queueAhead: 0n,
      queueBookEventId: null,
      queueBookMarketTime: null,
      cancelRequestedAt: null,
      cancelEffectiveAt: null,
      finalAt: null,
      ckptBetweenQueue: 0n,
      ckptFilled: 0n,
      awardedBySource: new Map(),
    };
    this.orders.set(order.orderId, order);
    this.emit({ kind: 'order_submitted', order, cost: this.config.placementCost, at: now });
    this.later(order.liveAt, now, () => this.goLive(order));
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
    if (this.matching) this.deferredCancels.push(order);
    else this.applyOrScheduleCancel(order, now);
    return true;
  }

  /**
   * A cancel takes effect immediately only when its effective time is now AND the order is already
   * acknowledged; a pending order whose liveAt is this same instant must go live first (the scheduler
   * runs the earlier-scheduled goLive before a cancel scheduled now), so its ledger lifecycle stays
   * order_live -> cancel_effective.
   */
  private applyOrScheduleCancel(order: PaperOrder, now: number): void {
    const at = order.cancelEffectiveAt ?? now;
    if (at <= now && order.isLive) this.applyCancel(order);
    else this.scheduler.schedule(Math.max(at, now), Priority.EXCHANGE, () => this.applyCancel(order));
  }

  /** Run a venue transition at `at`: immediately when it falls on the current instant (zero latency), else scheduled. */
  private later(at: number, now: number, fn: () => void): void {
    if (at <= now) fn();
    else this.scheduler.schedule(at, Priority.EXCHANGE, fn);
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

  // ---------------------------------------------------------------- matching

  /**
   * Match an observed print. `now` is its observation time. The print must respect the lag bound; the
   * engine routes anything beyond it to `noteDiscardedTrade`.
   */
  onTrade(trade: TradeEvent, now: number): void {
    if (trade.obsTime - trade.marketTime > this.maxTradeLagMs) {
      throw new RangeError(
        `print ${trade.eventId} lags ${trade.obsTime - trade.marketTime}ms > maxTradeLagMs ${this.maxTradeLagMs}; discard it via noteDiscardedTrade`,
      );
    }
    this.matching = true;
    try {
      this.matchTrade(trade, now);
    } finally {
      this.matching = false;
      const deferred = this.deferredCancels.splice(0);
      for (const o of deferred) this.applyOrScheduleCancel(o, now);
    }
  }

  private matchTrade(trade: TradeEvent, now: number): void {
    for (const side of ['buy', 'sell'] as const) {
      this.fold(side, now);
      // Orders not yet acknowledged whose liveAt is this instant: the print cannot fill them, but the
      // ledger records why (the print predates or coincides with activation on venue time).
      for (const o of this.orders.values()) {
        if (o.side !== side || o.isLive || o.state === 'rejected' || o.liveAt > now || !this.isPriceRelevant(o, trade)) continue;
        const reason: IneligibleReason = trade.marketTime < o.liveAt ? 'predates_activation' : 'at_activation_instant';
        this.emit({ kind: 'fill_ineligible', order: o, trade, reason, at: now });
      }
      const simOrders = this.simulationOrders(side);
      const relevant = simOrders.filter((o) => this.isPriceRelevant(o, trade));
      if (relevant.length === 0) continue;

      let anyEligible = false;
      for (const o of relevant) {
        const finalized = o.state === 'cancelled' && o.finalAt !== null && now > o.finalAt;
        if (trade.marketTime < o.liveAt) {
          if (!finalized) this.emit({ kind: 'fill_ineligible', order: o, trade, reason: 'predates_activation', at: now });
        } else if (trade.marketTime === o.liveAt) {
          if (!finalized) this.emit({ kind: 'fill_ineligible', order: o, trade, reason: 'at_activation_instant', at: now });
        } else if (o.cancelEffectiveAt !== null && trade.marketTime > o.cancelEffectiveAt) {
          if (!finalized) this.emit({ kind: 'fill_ineligible', order: o, trade, reason: 'after_cancellation', at: now });
        } else {
          anyEligible = true;
        }
      }
      if (!anyEligible) continue;

      const matcher = this.sides[side];
      insertVenueOrdered(matcher.trades, trade);
      const { states, levels, roles } = this.simulate(simOrders, matcher.trades);
      for (const [key, q] of levels) this.levels.get(key)!.queueAhead = q;
      const tradeRoles = roles.get(trade.eventId);
      // Award in price-time priority so same-instant fills are ledgered in the order the venue would report them.
      const inPriority = [...simOrders].sort((a, b) => {
        if (a.price !== b.price) return a.side === 'buy' ? (a.price > b.price ? -1 : 1) : a.price < b.price ? -1 : 1;
        return a.liveAt - b.liveAt;
      });
      for (const o of inPriority) {
        const st = states.get(o.orderId)!;
        const role = tradeRoles?.get(o.orderId);
        if (st.filled < o.filledQty) {
          throw new Error(`matching invariant broken: venue-ordered total ${st.filled} below awarded ${o.filledQty} for ${o.orderId}`);
        }
        o.betweenQueue = st.betweenQueue;
        o.queueAhead = (levels.get(levelKey(o.side, o.price)) ?? 0n) + st.betweenQueue;
        if (role && role.kind === 'queue_consumed') {
          this.emit({ kind: 'queue_consumed', order: o, trade, queueAheadBefore: role.queueBefore, queueAheadAfter: role.queueAfter, at: now });
        }
        this.reconcileAttribution(o, matcher.trades, roles, trade, now);
        if (o.filledQty !== st.filled) {
          throw new Error(`attribution invariant broken: booked ${o.filledQty} != venue-ordered total ${st.filled} for ${o.orderId}`);
        }
      }
    }
  }

  /**
   * A print the engine discarded (lag beyond the bound). If it was eligible for one of our orders the
   * data cannot establish whether it filled us: record the doubt, award nothing.
   */
  noteDiscardedTrade(trade: TradeEvent, now: number): void {
    for (const o of this.orders.values()) {
      if (!o.isLive || o.filledQty >= o.qty || !this.isPriceRelevant(o, trade) || !this.eligibleAt(o, trade.marketTime)) continue;
      this.emit({ kind: 'fill_uncertain', order: o, trade, reason: 'stale_print_discarded', at: now });
    }
  }

  private eligibleAt(o: PaperOrder, marketTime: number): boolean {
    return o.isLive && o.liveAt < marketTime && (o.cancelEffectiveAt === null || marketTime <= o.cancelEffectiveAt);
  }

  private isPriceRelevant(order: PaperOrder, trade: TradeEvent): boolean {
    if (order.side === 'buy') {
      return trade.price <= order.price && trade.aggressor !== 'buy';
    }
    return trade.price >= order.price && trade.aggressor !== 'sell';
  }

  /**
   * Orders that take part in a side's matching simulation: live ones and those whose eligibility window
   * can still intersect the reordering window. An order retires once every print that could involve it
   * has been folded: cancelled with cancelEffectiveAt below the cut, or fully filled within the folded prefix.
   */
  private simulationOrders(side: Side): PaperOrder[] {
    const cut = this.sides[side].cut;
    return [...this.orders.values()].filter((o) => {
      if (o.side !== side || !o.isLive || o.state === 'rejected') return false;
      if (o.state === 'cancelled' && o.cancelEffectiveAt !== null && o.cancelEffectiveAt < cut) return false;
      if (o.ckptFilled >= o.qty) return false;
      return true;
    });
  }

  /**
   * Venue-ordered matching from the orders' and levels' checkpoints over `trades`. Pure: touches no
   * exchange state. Each price level is one FIFO: [level queue][own 1][between 2][own 2]...; better-priced
   * levels are served first; a print through a level sweeps it (queues to zero, own orders filled in time
   * priority up to the print size).
   */
  private simulate(orders: PaperOrder[], trades: TradeEvent[]): SimResult {
    const states = new Map<string, SimState>(orders.map((o) => [o.orderId, { betweenQueue: o.ckptBetweenQueue, filled: o.ckptFilled }]));
    const levels = new Map<string, bigint>();
    for (const o of orders) {
      const key = levelKey(o.side, o.price);
      if (!levels.has(key)) levels.set(key, this.levels.get(key)?.ckptQueueAhead ?? 0n);
    }
    const roles = new Map<string, Map<string, Role>>();
    for (const trade of trades) {
      let available = trade.size;
      const cands = orders.filter((o) => this.eligibleAt(o, trade.marketTime) && this.isPriceRelevant(o, trade) && states.get(o.orderId)!.filled < o.qty);
      const tradeRoles = new Map<string, Role>();
      roles.set(trade.eventId, tradeRoles);
      if (cands.length === 0) continue;
      const side = cands[0]!.side;
      const prices = [...new Set(cands.map((o) => o.price))].sort((a, b) => (side === 'buy' ? (a > b ? -1 : 1) : a < b ? -1 : 1));
      for (const price of prices) {
        if (available <= 0n) break;
        const key = levelKey(side, price);
        const group = cands.filter((o) => o.price === price).sort((a, b) => a.liveAt - b.liveAt);
        const levelBefore = levels.get(key) ?? 0n;
        const through = side === 'buy' ? trade.price < price : trade.price > price;
        if (through) {
          levels.set(key, 0n);
          for (const o of group) {
            const st = states.get(o.orderId)!;
            const queueBefore = levelBefore + st.betweenQueue;
            st.betweenQueue = 0n;
            if (available <= 0n) continue;
            const fill = minBig(o.qty - st.filled, available);
            st.filled += fill;
            available -= fill;
            tradeRoles.set(o.orderId, { kind: 'through', queueBefore, queueAfter: 0n, fill });
          }
          continue;
        }
        // At our price: the level queue absorbs first, then each own order's between segment, then the order.
        if (available <= levelBefore) {
          const levelAfter = levelBefore - available;
          levels.set(key, levelAfter);
          for (const o of group) {
            const st = states.get(o.orderId)!;
            tradeRoles.set(o.orderId, { kind: 'queue_consumed', queueBefore: levelBefore + st.betweenQueue, queueAfter: levelAfter + st.betweenQueue, fill: 0n });
          }
          available = 0n;
          break;
        }
        available -= levelBefore;
        levels.set(key, 0n);
        for (const o of group) {
          if (available <= 0n) break;
          const st = states.get(o.orderId)!;
          const queueBefore = levelBefore + st.betweenQueue;
          if (available <= st.betweenQueue) {
            st.betweenQueue -= available;
            tradeRoles.set(o.orderId, { kind: 'queue_consumed', queueBefore, queueAfter: st.betweenQueue, fill: 0n });
            available = 0n;
            break;
          }
          available -= st.betweenQueue;
          st.betweenQueue = 0n;
          const fill = minBig(o.qty - st.filled, available);
          st.filled += fill;
          available -= fill;
          tradeRoles.set(o.orderId, { kind: 'queue_exhausted', queueBefore, queueAfter: 0n, fill });
        }
      }
    }
    return { states, levels, roles };
  }

  /** Advance the side's cut to now - maxTradeLagMs, folding prints that can no longer be preceded into checkpoints. */
  private fold(side: Side, now: number): void {
    const matcher = this.sides[side];
    const newCut = now - this.maxTradeLagMs;
    if (newCut <= matcher.cut) return;
    const toFold = matcher.trades.filter((t) => t.marketTime < newCut);
    if (toFold.length > 0) {
      const orders = this.simulationOrders(side);
      const { states, levels } = this.simulate(orders, toFold);
      for (const o of orders) {
        const st = states.get(o.orderId)!;
        o.ckptBetweenQueue = st.betweenQueue;
        o.ckptFilled = st.filled;
      }
      for (const [key, q] of levels) this.levels.get(key)!.ckptQueueAhead = q;
      matcher.trades = matcher.trades.filter((t) => t.marketTime >= newCut);
    }
    matcher.cut = newCut;
  }

  /**
   * Bring the order's booked per-source attribution in line with the venue-ordered simulation over the
   * window prints. Prints already folded keep their booked attribution (they can no longer change).
   * Decreases (a source now fills less than was booked to it) are moved to increasing sources as
   * `fill_reattributed`; the remaining increases are booked as new fills. Total booked == venue total.
   */
  private reconcileAttribution(order: PaperOrder, windowTrades: TradeEvent[], roles: SimResult['roles'], establishedBy: TradeEvent, now: number): void {
    type Change = { trade: TradeEvent; role: Role | undefined; next: bigint; booked: bigint; amount: bigint };
    const changes: Change[] = windowTrades.map((t) => {
      const role = roles.get(t.eventId)?.get(order.orderId);
      const next = role?.fill ?? 0n;
      const booked = order.awardedBySource.get(t.eventId)?.qty ?? 0n;
      return { trade: t, role, next, booked, amount: next - booked };
    });
    const decreases = changes.filter((c) => c.amount < 0n).map((c) => ({ ...c, amount: -c.amount }));
    const increases = changes.filter((c) => c.amount > 0n);
    for (const dec of decreases) {
      let remaining = dec.amount;
      for (const inc of increases) {
        if (remaining === 0n) break;
        const take = minBig(inc.amount, remaining);
        if (take <= 0n) continue;
        this.emit({ kind: 'fill_reattributed', order, fromTrade: dec.trade, toTrade: inc.trade, qty: take, establishedBy, at: now });
        inc.amount -= take;
        remaining -= take;
      }
      if (remaining !== 0n) throw new Error(`attribution invariant broken: ${remaining} of source ${dec.trade.eventId} has no new source for ${order.orderId}`);
    }
    for (const inc of increases) {
      if (inc.amount > 0n) this.award(order, inc.trade, establishedBy, inc.amount, inc.role, now);
    }
    for (const c of changes) {
      if (c.next > 0n) order.awardedBySource.set(c.trade.eventId, { trade: c.trade, qty: c.next });
      else order.awardedBySource.delete(c.trade.eventId);
    }
  }

  private award(order: PaperOrder, sourceTrade: TradeEvent, establishedBy: TradeEvent, qty: bigint, role: Role | undefined, now: number): void {
    const n = notional(order.price, qty);
    const fee = feeOn(n, this.config.makerFeeBps);
    // A cancel that took effect at this very instant (zero latency, kill switch) is still a race at
    // observation time: the late-fill row needs obsTime strictly after cancelEffectiveAt.
    const duringCancelPending = order.state === 'cancel_pending' || (order.state === 'cancelled' && now === order.cancelEffectiveAt);
    const afterCancelEffective = order.state === 'cancelled' && now > (order.cancelEffectiveAt ?? now);
    order.filledQty += qty;
    if (afterCancelEffective) {
      order.lateFilledQty += qty;
      this.emit({ kind: 'cancel_fill_race', order, trade: sourceTrade, at: now, outcome: 'late_fill_after_cancel_effective' });
    } else {
      if (order.state !== 'cancelled' && order.filledQty === order.qty) order.state = 'filled';
      if (duringCancelPending) {
        const outcome: RaceOutcome = sourceTrade.marketTime === order.cancelEffectiveAt ? 'fill_wins_tie' : 'fill_wins_before_cancel';
        this.emit({ kind: 'cancel_fill_race', order, trade: sourceTrade, at: now, outcome });
      }
    }
    const fillType: FillType = role?.kind === 'through' ? 'trade_through' : 'queue_exhausted';
    this.emit({
      kind: 'fill',
      order,
      sourceTrade,
      establishedBy,
      qty,
      notional: n,
      fee,
      fillType,
      queueAheadBefore: role?.queueBefore ?? order.queueAhead,
      duringCancelPending,
      afterCancelEffective,
      at: now,
    });
  }

  // ------------------------------------------------------------- transitions

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
    const bookLevels = order.side === 'buy' ? book.bids : book.asks;
    const displayed = bookLevels.find((l) => l.price === order.price)?.size ?? 0n;
    const key = levelKey(order.side, order.price);
    const ownAhead = this.simulationOrders(order.side).filter((o) => o !== order && o.price === order.price && o.isLive);
    let lvl = this.levels.get(key);
    if (!lvl || ownAhead.length === 0) {
      // First own order at this level (or the level had no own order left): the level queue is what is displayed now.
      lvl = { ckptQueueAhead: displayed, queueAhead: displayed };
      this.levels.set(key, lvl);
    }
    const between = ownAhead.length === 0 ? 0n : maxBig(0n, displayed - lvl.queueAhead);
    order.displayedAtLive = displayed;
    order.levelQueueAtLive = lvl.queueAhead;
    order.ownOrdersAheadAtLive = ownAhead.length;
    order.betweenQueueInitial = between;
    order.betweenQueue = between;
    order.ckptBetweenQueue = between;
    order.queueAhead = lvl.queueAhead + between;
    order.ckptFilled = 0n;
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

/** Insert keeping (marketTime, seq) order; stable for equal keys. */
function insertVenueOrdered(list: TradeEvent[], trade: TradeEvent): void {
  let i = list.length;
  while (i > 0) {
    const prev = list[i - 1]!;
    if (prev.marketTime < trade.marketTime || (prev.marketTime === trade.marketTime && prev.seq <= trade.seq)) break;
    i--;
  }
  list.splice(i, 0, trade);
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
