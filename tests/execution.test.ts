import { describe, expect, it } from 'vitest';
import {
  PaperExchange,
  Priority,
  Scheduler,
  parsePrice,
  parseQty,
  type BookEvent,
  type ExecutionConfig,
  type ExecutionEvent,
  type TradeEvent,
} from '../src/index.js';
import { T0, TICK, LOT } from './helpers.js';

const cfg: ExecutionConfig = {
  orderLatencyMs: 50,
  cancelLatencyMs: 50,
  makerFeeBps: 2n,
  placementCost: 5_000n,
  cancelCost: 2_000n,
  tickSize: TICK,
  lotSize: LOT,
};

function mkBook(t: number, bid: string, ask: string, bidSize = '2', askSize = '2'): BookEvent {
  const b = parsePrice(bid);
  const a = parsePrice(ask);
  return {
    type: 'book',
    eventId: `b${t}`,
    seq: t,
    obsTime: T0 + t,
    marketTime: T0 + t,
    symbol: 'X',
    venue: 'test',
    bids: [
      { price: b, size: parseQty(bidSize) },
      { price: b - TICK, size: parseQty('2') },
    ],
    asks: [
      { price: a, size: parseQty(askSize) },
      { price: a + TICK, size: parseQty('2') },
    ],
  };
}

/** `t` is the observation offset; `marketOffset` (default = t) is the venue time offset. */
function mkTrade(t: number, price: string, size: string, aggressor: 'buy' | 'sell' | 'unknown' = 'unknown', marketOffset: number = t): TradeEvent {
  return {
    type: 'trade',
    eventId: `t${t}-${marketOffset}`,
    seq: 1000 + t,
    obsTime: T0 + t,
    marketTime: T0 + marketOffset,
    symbol: 'X',
    venue: 'test',
    tradeId: `t${t}`,
    price: parsePrice(price),
    size: parseQty(size),
    aggressor,
  };
}

/** Minimal harness: a scheduler-driven exchange with a mutable "latest book" and a trade feed. */
function harness() {
  const scheduler = new Scheduler();
  const events: ExecutionEvent[] = [];
  let book: BookEvent | null = null;
  const ex = new PaperExchange(cfg, scheduler, (e) => events.push(e), () => book, { maxTradeLagMs: 500 });
  const feedBook = (b: BookEvent) => scheduler.schedule(b.obsTime, Priority.MARKET, () => void (book = b));
  const feedTrade = (t: TradeEvent) => scheduler.schedule(t.obsTime, Priority.MARKET, () => ex.onTrade(t, t.obsTime));
  const at = (t: number, priority: number, fn: () => void) => scheduler.schedule(T0 + t, priority, fn);
  const run = () => {
    for (;;) {
      const item = scheduler.pop();
      if (!item) return;
      void item.run();
    }
  };
  const kinds = () => events.map((e) => e.kind);
  const fills = () => events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill' }> => e.kind === 'fill');
  return { scheduler, events, ex, feedBook, feedTrade, at, run, kinds, fills, book: () => book };
}

describe('paper execution model', () => {
  it('a book touch without a printed trade never fills', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92', '2'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    // ask collapses onto our bid, then through it: still no print
    h.feedBook(mkBook(500, '99.80', '99.90'));
    h.feedBook(mkBook(600, '99.70', '99.85'));
    h.run();
    expect(h.fills()).toHaveLength(0);
    expect(h.kinds()).toEqual(['order_submitted', 'order_live']);
    const live = h.events[1] as Extract<ExecutionEvent, { kind: 'order_live' }>;
    expect(live.order.queueAhead).toBe(parseQty('2'));
    expect(live.order.state).toBe('live');
  });

  it('a trade at our price fills only after the displayed queue ahead is exhausted, and never more than the print', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92', '2'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    h.feedTrade(mkTrade(200, '99.90', '1.5', 'sell')); // queue 2 -> 0.5, no fill
    h.feedTrade(mkTrade(300, '99.90', '0.8', 'sell')); // queue 0.5 -> 0, excess 0.3 -> partial fill 0.3
    h.feedTrade(mkTrade(400, '99.90', '0.2', 'sell')); // queue 0 -> fill 0.2
    h.run();
    const fills = h.fills();
    expect(fills.map((f) => f.qty)).toEqual([parseQty('0.3'), parseQty('0.2')]);
    expect(fills.map((f) => f.fillType)).toEqual(['queue_exhausted', 'queue_exhausted']);
    expect(fills[0]!.queueAheadBefore).toBe(parseQty('0.5'));
    expect(h.kinds().filter((k) => k === 'queue_consumed')).toHaveLength(1);
    expect(h.ex.get(fills[0]!.order.orderId)!.state).toBe('live');
    expect(h.ex.get(fills[0]!.order.orderId)!.filledQty).toBe(parseQty('0.5'));
  });

  it('a trade through our price fills up to the print size regardless of queue', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92', '5'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    h.feedTrade(mkTrade(200, '99.89', '0.4', 'sell'));
    h.feedTrade(mkTrade(300, '99.85', '5', 'sell'));
    h.run();
    const fills = h.fills();
    expect(fills.map((f) => f.qty)).toEqual([parseQty('0.4'), parseQty('0.6')]);
    expect(fills.map((f) => f.fillType)).toEqual(['trade_through', 'trade_through']);
    expect(fills[1]!.order.state).toBe('filled');
    expect(fills[0]!.fee).toBe(7_992n); // 99.90 * 0.4 = 39.96; 2 bps = 0.007992 exactly
  });

  it('charges the maker fee rounded up to the money unit', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92', '0.5'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    h.feedTrade(mkTrade(200, '99.85', '0.4', 'sell'));
    h.run();
    const f = h.fills()[0]!;
    expect(f.notional).toBe(parsePrice('39.96')); // 99.90 * 0.4
    expect(f.fee).toBe(7_992n); // 39.96 * 2bps = 0.007992 exactly
  });

  it('cannot be filled by a trade printed before the order is live', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    h.feedTrade(mkTrade(149, '99.00', '3', 'sell')); // before live at 150
    h.feedTrade(mkTrade(150, '99.00', '3', 'sell')); // same ms as live: market first -> not live yet
    h.run();
    expect(h.fills()).toHaveLength(0);
    h.feedTrade(mkTrade(151, '99.00', '3', 'sell'));
    h.run();
    expect(h.fills()).toHaveLength(1);
  });

  it('rejects post-only orders that would cross at live time and rejects when no book exists', () => {
    const h = harness();
    h.at(0, Priority.TICK, () => h.ex.submit({ clientId: 'a', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0));
    h.feedBook(mkBook(20, '99.80', '99.85'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'b', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'sell', price: parsePrice('99.80'), qty: parseQty('1') }, T0 + 100));
    h.run();
    const rejected = h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'order_rejected' }> => e.kind === 'order_rejected');
    // a: submitted at t=0, live at 50 with the t=20 book present -> 99.90 >= ask 99.85 -> crossed
    // b: same; c: sell at 99.80 <= bid 99.80 -> crossed
    expect(rejected.map((r) => [r.order.clientId, r.reason])).toEqual([
      ['a', 'post_only_would_cross'],
      ['b', 'post_only_would_cross'],
      ['c', 'post_only_would_cross'],
    ]);
    expect(h.fills()).toHaveLength(0);
  });

  it('rejects an order that goes live before any book exists', () => {
    const h = harness();
    h.at(0, Priority.TICK, () => h.ex.submit({ clientId: 'a', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0));
    h.run();
    const rejected = h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'order_rejected' }> => e.kind === 'order_rejected');
    expect(rejected.map((r) => r.reason)).toEqual(['no_book']);
  });

  it('ignores prints whose aggressor is on our side of the book', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92', '0.5'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
    h.feedTrade(mkTrade(200, '99.85', '3', 'buy')); // a buy print below our bid is inconsistent with us resting there
    h.run();
    expect(h.fills()).toHaveLength(0);
  });

  describe('cancel / fill race', () => {
    function race(tradeAt: number) {
      const h = harness();
      h.feedBook(mkBook(0, '99.90', '99.92', '0.5'));
      h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
      h.at(400, Priority.TICK, () => h.ex.requestCancel('o1', T0 + 400, 'test')); // effective at 450
      h.feedTrade(mkTrade(tradeAt, '99.80', '1', 'sell'));
      h.run();
      return h;
    }

    it('trade strictly before the cancel takes effect: the fill wins and the cancel is too late', () => {
      const h = race(430);
      expect(h.fills()).toHaveLength(1);
      expect(h.fills()[0]!.duringCancelPending).toBe(true);
      expect(h.kinds()).toContain('cancel_fill_race');
      expect(h.kinds()).toContain('cancel_too_late');
      expect(h.kinds()).not.toContain('cancel_effective');
      expect(h.ex.get('o1')!.state).toBe('filled');
    });

    it('trade at the same millisecond as the cancel: the fill wins (documented tie rule)', () => {
      const h = race(450);
      expect(h.fills()).toHaveLength(1);
      expect(h.kinds()).toContain('cancel_too_late');
      expect(h.ex.get('o1')!.state).toBe('filled');
    });

    it('trade after the cancel takes effect: no fill, recorded as ineligible', () => {
      const h = race(451);
      expect(h.fills()).toHaveLength(0);
      expect(h.kinds()).toContain('cancel_effective');
      expect(h.ex.get('o1')!.state).toBe('cancelled');
      const inel = h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill_ineligible' }> => e.kind === 'fill_ineligible');
      expect(inel.map((e) => e.reason)).toEqual(['after_cancellation']);
    });

    it('is deterministic: identical inputs produce identical event sequences', () => {
      const a = race(450).events.map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      const b = race(450).events.map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      expect(a).toEqual(b);
    });

    it('a cancel requested before the order is live takes effect no earlier than the live time', () => {
      const h = harness();
      h.feedBook(mkBook(0, '99.90', '99.92', '0.5'));
      h.at(100, Priority.TICK, () => {
        h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100);
        h.ex.requestCancel('o1', T0 + 100, 'immediate'); // live at 150, cancel latency 50 -> effective at 150
      });
      h.feedTrade(mkTrade(150, '99.80', '1', 'sell')); // market first at 150, order not live -> no fill
      h.run();
      expect(h.fills()).toHaveLength(0);
      expect(h.ex.get('o1')!.state).toBe('cancelled');
      expect(h.ex.get('o1')!.cancelEffectiveAt).toBe(T0 + 150);
    });
  });

  describe('venue-time eligibility (marketTime vs obsTime)', () => {
    /** Order submitted at 100 -> live at 150 (venue). Optional cancel at 400 -> effective 450, final at 950. */
    function setup(opts: { cancel?: boolean; bidSize?: string } = {}) {
      const h = harness();
      h.feedBook(mkBook(0, '99.90', '99.92', opts.bidSize ?? '0'));
      h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 100));
      if (opts.cancel) h.at(400, Priority.TICK, () => h.ex.requestCancel('o1', T0 + 400, 'test'));
      return h;
    }
    const ineligible = (h: ReturnType<typeof harness>) =>
      h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill_ineligible' }> => e.kind === 'fill_ineligible').map((e) => e.reason);
    const uncertain = (h: ReturnType<typeof harness>) =>
      h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill_uncertain' }> => e.kind === 'fill_uncertain').map((e) => e.reason);

    it('a trade printed before activation but observed after it cannot fill', () => {
      const h = setup();
      h.feedTrade(mkTrade(200, '99.80', '1', 'sell', 120)); // observed at 200 (order live), printed at 120 (< liveAt 150)
      h.run();
      expect(h.fills()).toHaveLength(0);
      expect(ineligible(h)).toEqual(['predates_activation']);
      expect(h.ex.get('o1')!.state).toBe('live');
    });

    it('a trade printed at the activation instant is not awarded and is recorded as uncertain', () => {
      const h = setup();
      h.feedTrade(mkTrade(200, '99.80', '1', 'sell', 150));
      h.run();
      expect(h.fills()).toHaveLength(0);
      expect(ineligible(h)).toEqual(['at_activation_instant']);
    });

    it('a trade printed after activation fills when observed, booking at observation time', () => {
      const h = setup();
      h.feedTrade(mkTrade(400, '99.80', '1', 'sell', 151));
      h.run();
      const f = h.fills();
      expect(f).toHaveLength(1);
      expect(f[0]!.at).toBe(T0 + 400);
      expect(f[0]!.trade.marketTime).toBe(T0 + 151);
      expect(f[0]!.afterCancelEffective).toBe(false);
    });

    it('ineligible prints do not consume the queue ahead of us', () => {
      const h = setup({ bidSize: '2' });
      h.feedTrade(mkTrade(200, '99.90', '1.5', 'sell', 120)); // at our price, predates activation
      h.run();
      expect(h.ex.get('o1')!.queueAhead).toBe(parseQty('2'));
      expect(h.kinds()).not.toContain('queue_consumed');
      expect(ineligible(h)).toEqual(['predates_activation']);
    });

    it('a trade printed while live but observed after the cancel took effect is a late fill', () => {
      const h = setup({ cancel: true });
      h.feedTrade(mkTrade(600, '99.80', '0.4', 'sell', 440)); // printed before cancelEffectiveAt 450, observed at 600
      h.run();
      expect(h.kinds()).toContain('cancel_effective');
      const f = h.fills();
      expect(f).toHaveLength(1);
      expect(f[0]!.afterCancelEffective).toBe(true);
      expect(f[0]!.qty).toBe(parseQty('0.4'));
      expect(f[0]!.at).toBe(T0 + 600);
      const races = h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'cancel_fill_race' }> => e.kind === 'cancel_fill_race');
      expect(races.map((r) => r.outcome)).toEqual(['late_fill_after_cancel_effective']);
      const o = h.ex.get('o1')!;
      expect(o.state).toBe('cancelled');
      expect(o.lateFilledQty).toBe(parseQty('0.4'));
      expect(o.finalAt).toBe(T0 + 950);
    });

    it('a trade printed at the cancel instant and observed later still fills (fill wins the tie)', () => {
      const h = setup({ cancel: true });
      h.feedTrade(mkTrade(500, '99.80', '1', 'sell', 450));
      h.run();
      expect(h.fills()).toHaveLength(1);
      expect(h.fills()[0]!.afterCancelEffective).toBe(true);
    });

    it('a trade printed after the cancel took effect never fills, however early it is observed', () => {
      const h = setup({ cancel: true });
      h.feedTrade(mkTrade(500, '99.80', '1', 'sell', 460));
      h.run();
      expect(h.fills()).toHaveLength(0);
      expect(ineligible(h)).toEqual(['after_cancellation']);
    });

    it('an eligible print that had to be discarded (lag beyond the bound) is recorded as uncertain, not awarded', () => {
      const h = setup({ cancel: true });
      h.run();
      const late = mkTrade(1000, '99.80', '1', 'sell', 440); // lag 560 > 500: the engine discards it as stale
      expect(() => h.ex.onTrade(late, T0 + 1000)).toThrow(/maxTradeLagMs/);
      h.ex.noteDiscardedTrade(late, T0 + 1000);
      expect(h.fills()).toHaveLength(0);
      expect(uncertain(h)).toEqual(['stale_print_discarded']);
      expect(h.ex.get('o1')!.filledQty).toBe(0n);
      // a discarded print outside the order's venue-time window is not uncertainty for it
      h.ex.noteDiscardedTrade(mkTrade(1100, '99.80', '1', 'sell', 460), T0 + 1100);
      expect(uncertain(h)).toHaveLength(1);
    });

    it('a finalized order is not re-evaluated against ordinary later prints', () => {
      const h = setup({ cancel: true });
      h.feedTrade(mkTrade(1200, '99.80', '1', 'sell', 1190)); // long after finalAt 950, ordinary lag
      h.feedTrade(mkTrade(1300, '99.90', '1', 'sell', 1290));
      h.run();
      expect(h.fills()).toHaveLength(0);
      expect(ineligible(h)).toEqual([]);
      expect(uncertain(h)).toEqual([]);
      expect(h.kinds().filter((k) => k === 'queue_consumed')).toEqual([]);
    });

    it('late fills respect the remaining quantity and stop once the order is exhausted', () => {
      const h = setup({ cancel: true });
      h.feedTrade(mkTrade(600, '99.80', '0.7', 'sell', 440));
      h.feedTrade(mkTrade(610, '99.80', '0.7', 'sell', 445));
      h.feedTrade(mkTrade(620, '99.80', '0.7', 'sell', 446));
      h.run();
      expect(h.fills().map((f) => f.qty)).toEqual([parseQty('0.7'), parseQty('0.3')]);
      expect(h.ex.get('o1')!.filledQty).toBe(parseQty('1'));
      expect(h.ex.get('o1')!.lateFilledQty).toBe(parseQty('1'));
    });
  });

  it('shares one print across our own orders in price-time priority', () => {
    const h = harness();
    h.feedBook(mkBook(0, '99.90', '99.92', '0'));
    h.at(100, Priority.TICK, () => h.ex.submit({ clientId: 'a', side: 'buy', price: parsePrice('99.89'), qty: parseQty('1') }, T0 + 100));
    h.at(200, Priority.TICK, () => h.ex.submit({ clientId: 'b', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 200));
    h.feedTrade(mkTrade(400, '99.80', '1.5', 'sell'));
    h.run();
    const fills = h.fills();
    expect(fills.map((f) => [f.order.clientId, f.qty])).toEqual([
      ['b', parseQty('1')], // better price first
      ['a', parseQty('0.5')],
    ]);
  });
});
