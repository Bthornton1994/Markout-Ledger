import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTION,
  DEFAULT_PARAMS,
  DEFAULT_POLICY,
  INSTRUCTION_SCHEMA_VERSION,
  Ledger,
  MarketMakerPolicy,
  PaperExchange,
  Priority,
  Scheduler,
  ScriptedPolicy,
  mulberry32,
  parseMoney,
  parsePrice,
  parseQty,
  replay,
  type BookEvent,
  type ControllerContext,
  type ControllerProposal,
  type ExecutionEvent,
  type Fixture,
  type PolicyDecision,
  type PolicyInput,
  type SteeringController,
  type TradeEvent,
  type WindowReview,
} from '../src/index.js';
import { T0, TICK, fixedQuotePolicy, flatBooks, makeFixture, testConfig, trade } from './helpers.js';

/**
 * Regression tests for the findings of the adversarial probe run against a7bc418 (C0..C12).
 * Each test names the finding it pins.
 */

function mkBook(t: number, bidSize: string): BookEvent {
  const bids = [{ price: parsePrice('99.89'), size: parseQty('2') }];
  if (parseQty(bidSize) > 0n) bids.unshift({ price: parsePrice('99.90'), size: parseQty(bidSize) });
  return {
    type: 'book',
    eventId: `b${t}`,
    seq: t,
    obsTime: T0 + t,
    marketTime: T0 + t,
    symbol: 'X',
    venue: 'test',
    bids,
    asks: [
      { price: parsePrice('99.92'), size: parseQty('2') },
      { price: parsePrice('99.93'), size: parseQty('2') },
    ],
  };
}
function mkPrint(obs: number, market: number, price: string, size: string, aggressor: 'buy' | 'sell' | 'unknown' = 'sell'): TradeEvent {
  return { type: 'trade', eventId: `t${obs}-${market}-${price}`, seq: 10_000 + obs, obsTime: T0 + obs, marketTime: T0 + market, symbol: 'X', venue: 'test', tradeId: `t${obs}`, price: parsePrice(price), size: parseQty(size), aggressor };
}

type Harness = ReturnType<typeof harness>;
function harness(opts: { bidSize?: string; cancelLatencyMs?: number; onEvent?: (e: ExecutionEvent, h: Harness) => void } = {}) {
  const scheduler = new Scheduler();
  const events: ExecutionEvent[] = [];
  let latest: BookEvent | null = null;
  const self = {
    events,
    ex: null as unknown as PaperExchange,
    setBook: (t: number, bidSize: string) => scheduler.schedule(T0 + t, Priority.MARKET, () => void (latest = mkBook(t, bidSize))),
    submit: (t: number, side: 'buy' | 'sell', price: string, qty: string, id: string) =>
      scheduler.schedule(T0 + t, Priority.TICK, () => {
        self.ex.submit({ clientId: id, side, price: parsePrice(price), qty: parseQty(qty) }, T0 + t);
      }),
    feed: (tr: TradeEvent) => scheduler.schedule(tr.obsTime, Priority.MARKET, () => self.ex.onTrade(tr, tr.obsTime)),
    at: (t: number, priority: number, fn: () => void) => scheduler.schedule(T0 + t, priority, fn),
    run: () => {
      for (let item = scheduler.pop(); item; item = scheduler.pop()) void item.run();
    },
    fills: () => events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill' }> => e.kind === 'fill'),
    kindsFor: (orderId: string) => events.filter((e) => 'order' in e && e.order.orderId === orderId).map((e) => e.kind),
  };
  self.ex = new PaperExchange(
    { ...DEFAULT_EXECUTION, tickSize: TICK, cancelLatencyMs: opts.cancelLatencyMs ?? 50 },
    scheduler,
    (e) => {
      events.push(e);
      opts.onEvent?.(e, self);
    },
    () => latest,
    { maxTradeLagMs: 500 },
  );
  self.setBook(0, opts.bidSize ?? '2');
  return self;
}

describe('C0: own orders at one price form a single FIFO; a late earlier print never breaks per-order monotonicity', () => {
  it('the audit case: level queue captured by the first order, later order sits behind it; no throw, no over-award', () => {
    const h = harness({ bidSize: '2' });
    h.submit(20, 'buy', '99.90', '1', 'a'); // o1 live at 70: level queue 2.0
    h.setBook(75, '0.5'); // the level thins; queues never shrink from a book
    h.submit(30, 'buy', '99.90', '2', 'c'); // o2 live at 80: behind o1, between = max(0, 0.5 - 2.0) = 0
    h.feed(mkPrint(390, 380, '99.90', '2.5')); // P: level 2.0 absorbed, o1 fills 0.5, nothing left for o2
    h.feed(mkPrint(480, 370, '99.90', '1.0')); // X: earlier print observed late: level 2.0 -> 1.0, so P now fills o1 1.0 and o2 0.5
    expect(() => h.run()).not.toThrow();
    expect(h.fills().map((f) => [f.order.orderId, f.at - T0, f.sourceTrade.marketTime - T0, f.qty])).toEqual([
      ['o1', 390, 380, parseQty('0.5')],
      ['o1', 480, 380, parseQty('0.5')],
      ['o2', 480, 380, parseQty('0.5')],
    ]);
    const o2 = h.ex.get('o2')!;
    expect([o2.ownOrdersAheadAtLive, o2.levelQueueAtLive, o2.betweenQueueInitial, o2.displayedAtLive]).toEqual([1, parseQty('2'), 0n, parseQty('0.5')]);
    expect(h.ex.get('o1')!.filledQty + o2.filledQty).toBe(parseQty('1.5'));
  });

  it('a later own order at the same level never fills while an earlier one still rests (time priority)', () => {
    const h = harness({ bidSize: '2' });
    h.submit(20, 'buy', '99.90', '1', 'a'); // live 70
    h.setBook(75, '3'); // level grew by 1.0 behind o1
    h.submit(30, 'buy', '99.90', '1', 'c'); // live 80: between = 3.0 - 2.0 = 1.0
    h.feed(mkPrint(200, 190, '99.90', '2.3')); // level 2.0 absorbed, o1 takes 0.3, o2 untouched
    h.feed(mkPrint(300, 290, '99.90', '1.5')); // o1 takes its last 0.7, then o2's between 1.0 absorbs 0.8 -> no fill for o2
    h.feed(mkPrint(400, 390, '99.90', '0.5')); // between 0.2 absorbed, o2 fills 0.3
    h.run();
    expect(h.fills().map((f) => [f.order.orderId, f.at - T0, f.qty])).toEqual([
      ['o1', 200, parseQty('0.3')],
      ['o1', 300, parseQty('0.7')],
      ['o2', 400, parseQty('0.3')],
    ]);
    expect(h.ex.get('o2')!.queueAhead).toBe(0n);
  });

  it('seeded fuzz: random print sequences against several own orders never throw and never over-credit a print', () => {
    const rng = mulberry32(2026);
    for (let iter = 0; iter < 150; iter++) {
      const h = harness({ bidSize: ['0', '0.5', '2'][rng.int(0, 2)]!, cancelLatencyMs: [0, 50][rng.int(0, 1)]! });
      const n = rng.int(2, 3);
      for (let i = 0; i < n; i++) {
        h.submit(10 + i * 15, 'buy', ['99.90', '99.90', '99.89'][rng.int(0, 2)]!, `${rng.int(1, 20) / 10}`, `o${i}`);
        if (rng.chance(0.3)) h.setBook(12 + i * 15, `${rng.int(0, 30) / 10}`);
      }
      if (rng.chance(0.4)) {
        const tc = rng.int(120, 500);
        h.at(tc, Priority.TICK, () => h.ex.requestCancel('o1', T0 + tc, 'fuzz'));
      }
      const prints: TradeEvent[] = [];
      for (let k = 0; k < 6; k++) {
        const venue = rng.int(100, 600);
        const lag = rng.int(0, 400);
        prints.push(mkPrint(venue + lag, venue, ['99.90', '99.89', '99.85'][rng.int(0, 2)]!, `${rng.int(1, 30) / 10}`));
      }
      // distinct event ids even when obs/venue/price collide
      prints.forEach((p, k) => void ((p as { eventId: string }).eventId = `f${iter}-${k}`));
      for (const p of prints) h.feed(p);
      expect(() => h.run(), `iteration ${iter}`).not.toThrow();
      const credit = new Map<string, bigint>();
      for (const e of h.events) {
        if (e.kind === 'fill') credit.set(e.sourceTrade.eventId, (credit.get(e.sourceTrade.eventId) ?? 0n) + e.qty);
        if (e.kind === 'fill_reattributed') {
          credit.set(e.fromTrade.eventId, (credit.get(e.fromTrade.eventId) ?? 0n) - e.qty);
          credit.set(e.toTrade.eventId, (credit.get(e.toTrade.eventId) ?? 0n) + e.qty);
        }
      }
      for (const p of prints) expect((credit.get(p.eventId) ?? 0n) <= p.size, `iteration ${iter} print ${p.eventId}`).toBe(true);
      for (const [, q] of credit) expect(q >= 0n).toBe(true);
      for (let i = 0; i < n; i++) {
        const o = h.ex.get(`o${i + 1}`)!;
        expect(o.filledQty <= o.qty).toBe(true);
        expect([...o.awardedBySource.values()].reduce((s, a) => s + a.qty, 0n)).toBe(o.filledQty);
      }
    }
  });
});

describe('C1: a zero-latency cancel of an order that goes live this very instant still records order_live first', () => {
  it('kill switch during a print at exactly liveAt: lifecycle is submitted -> cancel_requested -> live -> cancel_effective', () => {
    const h = harness({ cancelLatencyMs: 0 });
    h.submit(100, 'buy', '99.90', '1', 'a'); // live at 150
    h.at(150, Priority.MARKET, () => h.ex.requestCancel('o1', T0 + 150, 'kill_switch')); // a fill at MARKET priority tripped the kill switch
    h.run();
    expect(h.kindsFor('o1')).toEqual(['order_submitted', 'cancel_requested', 'order_live', 'cancel_effective']);
    const o = h.ex.get('o1')!;
    expect([o.state, o.isLive, o.cancelEffectiveAt]).toEqual(['cancelled', true, T0 + 150]);
  });
});

describe('C2: a print at or before activation that is observed at the activation instant is recorded as ineligible', () => {
  it('zero-lag prints at liveAt and just before it both leave a fill_ineligible entry and no fill', async () => {
    const fx = makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(40, '99.85', '1', 'sell', { lag: 10 }), trade(50, '99.85', '1', 'sell')], { durationMs: 3000 });
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('fill')).toHaveLength(0);
    expect(r.ledger.ofType('fill_ineligible').map((e) => [e.simTime - T0, e.tradeMarketTime - T0, e.reason])).toEqual([
      [50, 40, 'predates_activation'],
      [50, 50, 'at_activation_instant'],
    ]);
    expect(r.summary.fills.ineligibleByReason).toEqual({ predatesActivation: 1, atActivationInstant: 1, afterCancellation: 0 });
  });
});

describe('C3/C12: a cancel taking effect at the observation instant is a race, not a late fill', () => {
  function killDuringMatching(marketOffset: number) {
    const h = harness({
      bidSize: '0',
      cancelLatencyMs: 0,
      onEvent: (e, self) => {
        if (e.kind === 'fill' && e.order.orderId === 'o1') self.ex.requestCancel('o2', e.at, 'kill_switch'); // re-entrant, as the engine's loss check does
      },
    });
    h.submit(20, 'buy', '99.90', '1', 'a'); // o1 live 70
    h.submit(30, 'buy', '99.89', '2', 'b'); // o2 live 80
    h.feed(mkPrint(350, marketOffset, '99.80', '2')); // o1 takes 1.0, o2 takes 1.0 of its 2.0
    h.run();
    return h;
  }

  it('print before the cancel instant: fill_wins_before_cancel, then the cancel takes effect on the remainder', () => {
    const h = killDuringMatching(340);
    expect(h.kindsFor('o2')).toEqual(['order_submitted', 'order_live', 'cancel_requested', 'cancel_fill_race', 'fill', 'cancel_effective']);
    const fill = h.fills().find((f) => f.order.orderId === 'o2')!;
    expect([fill.afterCancelEffective, fill.duringCancelPending, fill.qty]).toEqual([false, true, parseQty('1')]);
    const race = h.events.find((e): e is Extract<ExecutionEvent, { kind: 'cancel_fill_race' }> => e.kind === 'cancel_fill_race' && e.order.orderId === 'o2')!;
    expect(race.outcome).toBe('fill_wins_before_cancel');
    const o2 = h.ex.get('o2')!;
    expect([o2.state, o2.filledQty, o2.lateFilledQty, o2.cancelEffectiveAt]).toEqual(['cancelled', parseQty('1'), 0n, T0 + 350]);
  });

  it('print at the cancel instant: fill_wins_tie', () => {
    const h = killDuringMatching(350);
    const race = h.events.find((e): e is Extract<ExecutionEvent, { kind: 'cancel_fill_race' }> => e.kind === 'cancel_fill_race' && e.order.orderId === 'o2')!;
    expect(race.outcome).toBe('fill_wins_tie');
    expect(h.fills().find((f) => f.order.orderId === 'o2')!.afterCancelEffective).toBe(false);
  });
});

describe('C4/C5: a controller cannot reach the engine through the objects it is handed', () => {
  class HostileController implements SteeringController {
    readonly id = 'hostile';
    readonly kind = 'scripted' as const;
    readonly modeledLatencyMs = 0;
    async decide(review: WindowReview, ctx: ControllerContext): Promise<ControllerProposal> {
      ctx.priorInstruction.params.spreadMultiplierMilli = 9000; // out of bounds, on a live reference in the old code
      (review as { activity: { fills: number } }).activity.fills = 999;
      const w = review.window.index;
      if (w === 0) throw new Error('boom');
      if (w === 1) return { instruction: { ...ctx.priorInstruction, version: ctx.nextVersion, basedOnWindow: w, effectiveFrom: ctx.nextWindow.start } }; // carries 9000 -> invalid
      return {
        instruction: {
          schemaVersion: INSTRUCTION_SCHEMA_VERSION,
          version: ctx.nextVersion,
          controllerId: this.id,
          basedOnWindow: w,
          issuedAt: review.window.end,
          effectiveFrom: ctx.nextWindow.start,
          params: { ...DEFAULT_PARAMS, spreadMultiplierMilli: 2000 },
          reason: 'valid',
        },
      };
    }
  }

  it('rejected proposals leave the accepted instruction untouched, accepted ones stay as hashed, reviews stay as logged', async () => {
    const fx = makeFixture(flatBooks(0, 15000, '100.00', '100.02'), { durationMs: 15000 });
    const r = await replay({ fixture: fx, policy: new MarketMakerPolicy(DEFAULT_POLICY), controller: new HostileController(), config: testConfig() });
    expect(r.ledger.ofType('instruction_rejected').map((x) => x.reason)).toEqual(['controller_failed', 'invalid']);
    const accepted = r.ledger.ofType('instruction_accepted');
    expect(accepted.map((a) => [a.instruction.version, a.instruction.params.spreadMultiplierMilli])).toEqual([
      [1, 2000],
      [2, 2000],
    ]);
    expect(r.ledger.ofType('window_summary').map((w) => w.paramsInEffectAtEnd.spreadMultiplierMilli)).toEqual([1000, 1000, 1000, 2000, 2000]);
    expect(r.ledger.ofType('controller_input').every((c) => c.review.activity.fills === 0)).toBe(true);
    expect(Ledger.verify(r.ledger.all())).toEqual({ ok: true });
    expect(r.summary.instructions.history.map((h) => h.params.spreadMultiplierMilli)).toEqual([1000, 2000, 2000]);
  });
});

describe('C6: superseded portions are not pending outcomes', () => {
  it('after a full re-attribution only the live portion counts as pending', async () => {
    const fx = makeFixture(
      [...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(200, '99.85', '1.0', 'sell', { lag: 50 }), trade(100, '99.85', '1.0', 'sell', { lag: 200 })],
      { durationMs: 3000 },
    );
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('fill_reattributed').map((x) => x.qty)).toEqual(['1.000000']);
    const outcomes = r.ledger.ofType('outcome');
    expect(outcomes.map((o) => [o.simTime - T0, o.sourceMarketTime - T0, o.horizonMs, o.status])).toEqual([
      [1100, 100, 1000, 'measured'],
      [1200, 200, 1000, 'superseded_by_reattribution'],
    ]);
    // the live portion's 3 s horizon is the only outcome still pending at the end of the replay
    expect(r.summary.outcomesPendingAtEnd).toBe(1);
    expect(r.ledger.ofType('controller_input')[0]!.review.outcomes.pendingAtWindowEnd).toBe(1);
  });
});

describe('C7: a fill that reduces a position beyond the limit is not another overrun', () => {
  it('one position_overrun for the late fill that crossed the limit, none for the reducing sell', async () => {
    const policy = new ScriptedPolicy((input: PolicyInput): PolicyDecision => {
      if (!input.book) return { intent: 'hold', bid: null, ask: null, reason: 'no book' };
      if (input.tick === 3) return { intent: 'pull', bid: null, ask: null, reason: 'pull' };
      return {
        intent: 'quote',
        bid: { price: parsePrice('99.90'), qty: parseQty('1') },
        ask: input.tick >= 5 ? { price: parsePrice('100.10'), qty: parseQty('0.2') } : null,
        reason: 'probe',
      };
    });
    const fx = makeFixture(
      [
        ...flatBooks(0, 3000, '99.90', '100.00', 100, { bidSize: '0', askSize: '0' }),
        trade(60, '99.80', '0.3', 'sell', { lag: 40 }), // 0.3 on order 1
        trade(940, '99.80', '0.7', 'sell', { lag: 360 }), // late fill on order 1 after its cancel (950), observed 1300
        trade(1300, '99.80', '1', 'sell'), // fills the replacement order: inventory 2.0 > 1.5 -> overrun
        trade(1700, '100.10', '0.2', 'buy'), // fills the ask: inventory 1.8, still over the limit but reducing
      ],
      { durationMs: 3000 },
    );
    const cfg = testConfig({ steering: 'disabled', risk: { ...testConfig().risk, maxPosition: parseQty('1.5'), maxOrderQty: parseQty('1') } });
    const r = await replay({ fixture: fx, policy, controller: null, config: cfg });
    expect(r.ledger.ofType('fill').map((f) => [f.simTime - T0, f.side, f.qty])).toEqual([
      [100, 'buy', '0.300000'],
      [1300, 'buy', '0.700000'],
      [1300, 'buy', '1.000000'],
      [1700, 'sell', '0.200000'],
    ]);
    expect(r.ledger.ofType('risk_breach').map((b) => [b.kind, b.simTime - T0])).toEqual([['position_overrun', 1300]]);
    expect(r.summary.risk.positionOverruns).toBe(1);
    expect(parseQty(r.summary.portfolio.inventory)).toBe(parseQty('1.8'));
  });
});

describe('C8: a discarded print is uncertainty only for orders that still had quantity to fill', () => {
  const fixture = (bSize: string) =>
    makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(200, '99.85', bSize, 'sell', { lag: 50 }), trade(100, '99.85', '1', 'sell', { lag: 600 })], { durationMs: 3000 });

  it('fully filled order: no fill_uncertain', async () => {
    const r = await replay({ fixture: fixture('1.0'), policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('observation_rejected').map((x) => x.reason)).toEqual(['stale_observation']);
    expect(r.ledger.ofType('fill_uncertain')).toHaveLength(0);
    expect(r.summary.fills.uncertain).toBe(0);
  });

  it('partially filled order: still uncertain', async () => {
    const r = await replay({ fixture: fixture('0.4'), policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('fill_uncertain').map((u) => [u.orderId, u.reason])).toEqual([['o1', 'stale_print_discarded']]);
  });
});

describe('C9/C10/C11: stream validation taxonomy and bookkeeping across content rejections', () => {
  it('a non-integer venue timestamp is invalid_timestamps', async () => {
    const fx = makeFixture(flatBooks(0, 3000, '100.00', '100.02'), { durationMs: 3000 });
    (fx.events[1] as { marketTime: number }).marketTime = T0 + 100.5;
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({}), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('observation_rejected').map((x) => [x.eventId, x.reason, x.phase, x.simTime - T0])).toEqual([['e1', 'invalid_timestamps', 'content', 100]]);
  });

  it('an eventId or seq first seen on a content-rejected event is still taken', async () => {
    const base = makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(250, '99.85', '0.3', 'sell', { id: 'X' }), trade(400, '99.85', '0.3', 'sell', { id: 'X' })], { durationMs: 3000 });
    const dup: Fixture = { ...base, events: base.events.map((e) => (e.eventId === 'X' && e.obsTime === T0 + 250 ? { ...e, symbol: 'OTHER' } : e)) };
    const r = await replay({ fixture: dup, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('observation_rejected').map((x) => [x.eventId, x.reason, x.simTime - T0])).toEqual([
      ['X', 'wrong_symbol', 250],
      ['X', 'duplicate_event', 400],
    ]);
    expect(r.ledger.ofType('fill')).toHaveLength(0);

    const seqBase = makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(250, '99.85', '0.3', 'sell', { id: 'R' }), trade(260, '99.85', '0.3', 'sell', { id: 'N' })], { durationMs: 3000 });
    const rSeq = seqBase.events.find((e) => e.eventId === 'R')!.seq;
    const seqDup: Fixture = {
      ...seqBase,
      events: seqBase.events.map((e) => (e.eventId === 'R' ? { ...e, symbol: 'OTHER' } : e.eventId === 'N' ? { ...e, seq: rSeq } : e)),
    };
    const r2 = await replay({ fixture: seqDup, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r2.ledger.ofType('observation_rejected').map((x) => [x.eventId, x.reason])).toEqual([
      ['R', 'wrong_symbol'],
      ['N', 'non_increasing_seq'],
    ]);
    expect(r2.ledger.ofType('fill')).toHaveLength(0);
  });
});

describe('accounting under the level FIFO', () => {
  it('a replay with two same-price own orders and re-ordered prints still reconciles', async () => {
    const policy = new ScriptedPolicy((input: PolicyInput): PolicyDecision => {
      if (!input.book) return { intent: 'hold', bid: null, ask: null, reason: 'no book' };
      return { intent: 'quote', bid: { price: parsePrice('99.90'), qty: parseQty(input.tick === 0 ? '1' : '2') }, ask: null, reason: 'probe' };
    });
    const fx = makeFixture(
      [
        ...flatBooks(0, 250, '99.90', '99.92', 50, { bidSize: '2' }),
        ...flatBooks(300, 3000, '99.90', '99.92', 100, { bidSize: '0.5' }),
        trade(380, '99.90', '2.5', 'sell', { lag: 10 }),
        trade(370, '99.90', '1.0', 'sell', { lag: 110 }),
      ],
      { durationMs: 3000 },
    );
    const cfg = testConfig({ steering: 'disabled', execution: { ...DEFAULT_EXECUTION, cancelLatencyMs: 100 } });
    const r = await replay({ fixture: fx, policy, controller: null, config: cfg });
    const p = r.summary.portfolio;
    expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));
    expect(r.ledger.ofType('fill').reduce((s, f) => s + parseQty(f.qty), 0n)).toBe(parseQty(p.inventory));
    expect(Ledger.verify(r.ledger.all())).toEqual({ ok: true });
  });
});

/**
 * N1 (Independent QA HIGH, SHA 574a8d3c): a print with venue time at or before a later own
 * order's liveAt must not consume that order's displayed queue, even when it is eligible for
 * an earlier own order at the same price and arrives out of venue order inside the lag bound.
 */
describe('N1: pre-activation prints must not consume a later own order\'s displayed queue', () => {
  function fillsOf(h: Harness, orderId: string) {
    return h.fills().filter((f) => f.order.orderId === orderId);
  }

  /** Independent QA §4.1: A live then provisionally cancelled; replacement B at the same price. */
  function replacementHarness(lateObs: number, secondSize = '1.0') {
    const h = harness({ bidSize: '2' });
    h.submit(0, 'buy', '99.90', '1', 'a'); // o1 live at 50, level queue 2.0
    h.at(300, Priority.TICK, () => {
      h.ex.requestCancel('o1', T0 + 300, 'requote'); // effective 350, final 850
    });
    h.submit(600, 'buy', '99.90', '1', 'b'); // o2 live at 650 while A is still provisional
    h.feed(mkPrint(lateObs, 320, '99.90', '1.2')); // inside A's window; predates B
    h.feed(mkPrint(800, 800, '99.90', secondSize));
    h.run();
    return h;
  }

  it('the replacement receives zero fills whether the pre-activation print arrives in venue order or late within the lag bound', () => {
    const inOrder = replacementHarness(330); // obs 330 < B liveAt 650
    const outOfOrder = replacementHarness(700); // obs 700, lag 380 <= 500
    expect(fillsOf(inOrder, 'o2').map((f) => f.qty)).toEqual([]);
    expect(fillsOf(outOfOrder, 'o2').map((f) => f.qty)).toEqual([]);
    expect(fillsOf(outOfOrder, 'o2').map((f) => f.qty)).toEqual(fillsOf(inOrder, 'o2').map((f) => f.qty));
    expect(inOrder.ex.get('o2')!.filledQty).toBe(0n);
    expect(outOfOrder.ex.get('o2')!.filledQty).toBe(0n);
    expect(inOrder.ex.get('o2')!.queueAhead).toBe(outOfOrder.ex.get('o2')!.queueAhead);
    expect(outOfOrder.events.some((e) => e.kind === 'fill_ineligible' && e.order.orderId === 'o2' && e.reason === 'predates_activation')).toBe(true);
  });

  it('a late print still late-fills the provisionally cancelled order; leftover never reaches the replacement', () => {
    const h = harness({ bidSize: '2' });
    h.submit(0, 'buy', '99.90', '1', 'a');
    h.at(300, Priority.TICK, () => h.ex.requestCancel('o1', T0 + 300, 'requote'));
    h.submit(600, 'buy', '99.90', '1', 'b');
    h.feed(mkPrint(700, 320, '99.90', '3.0')); // 2.0 queue + 1.0 fills A; B ineligible
    h.feed(mkPrint(800, 800, '99.90', '1.0')); // absorbed by B's preserved 2.0 queue
    h.run();
    expect(fillsOf(h, 'o1').map((f) => [f.qty, f.afterCancelEffective, f.at - T0])).toEqual([[parseQty('1'), true, 700]]);
    expect(fillsOf(h, 'o2')).toHaveLength(0);
    expect(h.ex.get('o1')!.lateFilledQty).toBe(parseQty('1'));
    expect(h.ex.get('o1')!.state).toBe('cancelled');
    expect(fillsOf(h, 'o1')[0]!.qty <= h.fills()[0]!.sourceTrade.size).toBe(true);
  });

  it('concurrent live orders keep time priority and the later order keeps the volume displayed at its liveAt', () => {
    function run(lateObs: number) {
      const h = harness({ bidSize: '2' });
      h.submit(0, 'buy', '99.90', '1', 'a'); // live 50
      h.submit(600, 'buy', '99.90', '1', 'b'); // live 650; both rest
      h.feed(mkPrint(lateObs, 320, '99.90', '1.2'));
      h.feed(mkPrint(800, 800, '99.90', '2.5')); // 0.8 level + 1.0 A; 0.7 leftover < B's preserved 1.2 between
      h.run();
      return h;
    }
    const inOrder = run(330);
    const outOfOrder = run(700);
    expect(inOrder.fills().map((f) => [f.order.orderId, f.qty])).toEqual([['o1', parseQty('1')]]);
    expect(outOfOrder.fills().map((f) => [f.order.orderId, f.qty])).toEqual(inOrder.fills().map((f) => [f.order.orderId, f.qty]));
    expect(inOrder.ex.get('o2')!.filledQty).toBe(0n);
    expect(outOfOrder.ex.get('o2')!.filledQty).toBe(0n);
    expect(inOrder.ex.get('o1')!.filledQty).toBe(parseQty('1'));
  });

  it('once a later eligible print exhausts the preserved queue, both permutations fill the replacement identically', () => {
    const inOrder = replacementHarness(330, '3.0');
    const outOfOrder = replacementHarness(700, '3.0');
    const o2In = fillsOf(inOrder, 'o2').map((f) => [f.qty, f.queueAheadBefore, f.at - T0, f.sourceTrade.marketTime - T0]);
    const o2Out = fillsOf(outOfOrder, 'o2').map((f) => [f.qty, f.queueAheadBefore, f.at - T0, f.sourceTrade.marketTime - T0]);
    expect(o2In).toEqual([[parseQty('1'), parseQty('2'), 800, 800]]);
    expect(o2Out).toEqual(o2In);
    expect(fillsOf(inOrder, 'o2')[0]!.qty <= fillsOf(inOrder, 'o2')[0]!.sourceTrade.size).toBe(true);
  });

  it('preserving the replacement queue survives folding the pre-activation print out of the reordering window', () => {
    function run(lateObs: number) {
      const h = harness({ bidSize: '2' });
      h.submit(0, 'buy', '99.90', '1', 'a');
      h.at(300, Priority.TICK, () => h.ex.requestCancel('o1', T0 + 300, 'requote'));
      h.submit(600, 'buy', '99.90', '1', 'b');
      h.feed(mkPrint(lateObs, 320, '99.90', '1.2'));
      h.feed(mkPrint(900, 900, '99.90', '0.1')); // fold cut = 400; venue 320 is folded
      h.run();
      return h;
    }
    const inOrder = run(330);
    const outOfOrder = run(700);
    expect(fillsOf(inOrder, 'o2')).toHaveLength(0);
    expect(fillsOf(outOfOrder, 'o2')).toHaveLength(0);
    expect(inOrder.ex.get('o2')!.queueAhead).toBe(parseQty('1.9'));
    expect(outOfOrder.ex.get('o2')!.queueAhead).toBe(inOrder.ex.get('o2')!.queueAhead);
  });

  it('a through print observed late that predates the replacement also leaves its displayed queue intact', () => {
    function run(lateObs: number) {
      const h = harness({ bidSize: '2' });
      h.submit(0, 'buy', '99.90', '1', 'a');
      h.at(300, Priority.TICK, () => h.ex.requestCancel('o1', T0 + 300, 'requote'));
      h.submit(600, 'buy', '99.90', '1', 'b');
      h.feed(mkPrint(lateObs, 320, '99.89', '0.5'));
      h.feed(mkPrint(800, 800, '99.90', '1.0'));
      h.run();
      return h;
    }
    const inOrder = run(330);
    const outOfOrder = run(700);
    expect(fillsOf(inOrder, 'o2')).toHaveLength(0);
    expect(fillsOf(outOfOrder, 'o2')).toHaveLength(0);
    expect(fillsOf(inOrder, 'o1').map((f) => f.qty)).toEqual([parseQty('0.5')]);
    expect(fillsOf(outOfOrder, 'o1').map((f) => f.qty)).toEqual(fillsOf(inOrder, 'o1').map((f) => f.qty));
  });

  it('engine §4.1: in-order and out-of-order feeds give the replacement identical zero fills; ledger reconciles', async () => {
    const run = (lag: number) => {
      const fx = makeFixture(
        [
          ...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '2' }),
          trade(320, '99.90', '1.2', 'sell', { lag, id: 'late-print' }),
          trade(800, '99.90', '1.0', 'sell', { id: 'small-print' }),
        ],
        { durationMs: 3000 },
      );
      return replay({
        fixture: fx,
        policy: fixedQuotePolicy({ bid: '99.90', qty: '1', pullTicks: [1] }),
        controller: null,
        config: testConfig({ steering: 'disabled' }),
      });
    };
    const inOrder = await run(10);
    const outOfOrder = await run(380);
    const o2 = (r: Awaited<ReturnType<typeof run>>) => r.ledger.ofType('fill').filter((f) => f.orderId === 'o2');
    expect(o2(inOrder)).toHaveLength(0);
    expect(o2(outOfOrder)).toHaveLength(0);
    expect(inOrder.summary.fills.count).toBe(outOfOrder.summary.fills.count);
    expect(inOrder.ledger.ofType('order_live').find((e) => e.orderId === 'o2')!.queueAhead).toBe('2.000000');
    expect(outOfOrder.ledger.ofType('order_live').find((e) => e.orderId === 'o2')!.queueAhead).toBe('2.000000');
    expect(outOfOrder.ledger.ofType('fill_ineligible').some((e) => e.orderId === 'o2' && e.reason === 'predates_activation')).toBe(true);
    for (const r of [inOrder, outOfOrder]) {
      expect(Ledger.verify(r.ledger.all())).toEqual({ ok: true });
      const p = r.summary.portfolio;
      expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));
      for (const f of r.ledger.ofType('fill')) {
        expect(parseQty(f.qty) <= parseQty(f.sourceTradeSize)).toBe(true);
        expect(f.observedAt).toBe(f.simTime);
        expect(f.sourceMarketTime).toBeLessThanOrEqual(f.observedAt);
      }
      const o1Cancel = r.ledger.ofType('cancel_effective').find((e) => e.orderId === 'o1')!;
      expect(r.ledger.ofType('fill').every((f) => f.orderId !== 'o1' || f.sourceMarketTime <= o1Cancel.simTime)).toBe(true);
    }
  });
});

/**
 * N4 (Independent QA HIGH, SHA b7dbe88): shifting pre-activation level consumption into
 * betweenQueue must not double-count when a venue-earlier print is observed after liveAt and
 * re-attributes consumption that a later-venue print (already baked into between at activation)
 * had taken. Replay must not abort; B's queue stays the 2.0 displayed-at-activation snapshot.
 */
describe('N4: re-attributing pre-activation consumption must not double-count between', () => {
  function fillsOf(h: Harness, orderId: string) {
    return h.fills().filter((f) => f.order.orderId === orderId);
  }

  /**
   * Audit minimal reproducer. P_late venue 264 / P_early venue 280 (reversed venue vs the
   * names: "early" is the one observed first in the failing feed). A live 50 level 2.0;
   * cancel at 300; B live 650 with displayed 2.0; P_post 2.5 at 700 fills B 0.5 in-order.
   */
  function n4Harness(feed: 'in-order' | 'reversed', postObs = 700) {
    const h = harness({ bidSize: '2' });
    h.submit(0, 'buy', '99.90', '1', 'a');
    h.at(300, Priority.TICK, () => h.ex.requestCancel('o1', T0 + 300, 'requote'));
    h.submit(600, 'buy', '99.90', '1', 'b');
    if (feed === 'in-order') {
      h.feed(mkPrint(274, 264, '99.90', '1.2')); // P_late in venue order, obs before B
      h.feed(mkPrint(290, 280, '99.90', '1.5'));
    } else {
      h.feed(mkPrint(300, 280, '99.90', '1.5')); // observed first, later venue time
      h.feed(mkPrint(750, 264, '99.90', '1.2')); // obs 750, lag 486; venue-earlier
    }
    h.feed(mkPrint(postObs, 700, '99.90', '2.5'));
    return h;
  }

  it('reversed observation vs venue order does not abort and matches in-order fills against the 2.0 activation queue', () => {
    const inOrder = n4Harness('in-order');
    const reversed = n4Harness('reversed');
    expect(() => inOrder.run()).not.toThrow();
    expect(() => reversed.run()).not.toThrow();
    const liveQueue = (h: Harness) => {
      const live = h.events.find((e) => e.kind === 'order_live' && e.order.orderId === 'o2') as Extract<ExecutionEvent, { kind: 'order_live' }>;
      return [live.order.displayedAtLive, live.order.queueAhead];
    };
    expect(liveQueue(inOrder)).toEqual([parseQty('2'), parseQty('2')]);
    expect(liveQueue(reversed)).toEqual([parseQty('2'), parseQty('2')]);
    const o2 = (h: Harness) => fillsOf(h, 'o2').map((f) => [f.qty, f.queueAheadBefore, f.at - T0, f.sourceTrade.marketTime - T0]);
    expect(o2(inOrder)).toEqual([[parseQty('0.5'), parseQty('2'), 700, 700]]);
    expect(o2(reversed)).toEqual(o2(inOrder));
    expect(inOrder.ex.get('o2')!.filledQty).toBe(parseQty('0.5'));
    expect(reversed.ex.get('o2')!.filledQty).toBe(inOrder.ex.get('o2')!.filledQty);
  });

  it('when the eligible print is observed after the late earlier print, both permutations still fill 0.5 (no silent under-award)', () => {
    const inOrder = n4Harness('in-order', 800);
    const reversed = n4Harness('reversed', 800);
    expect(() => inOrder.run()).not.toThrow();
    expect(() => reversed.run()).not.toThrow();
    const o2 = (h: Harness) => fillsOf(h, 'o2').map((f) => [f.qty, f.queueAheadBefore]);
    expect(o2(inOrder)).toEqual([[parseQty('0.5'), parseQty('2')]]);
    expect(o2(reversed)).toEqual(o2(inOrder));
  });

  it('engine: reversed pre-activation prints do not abort replay and match in-order replacement fills', async () => {
    const run = (kind: 'in-order' | 'reversed') => {
      const pre =
        kind === 'in-order'
          ? [trade(264, '99.90', '1.2', 'sell', { lag: 10, id: 'p-late' }), trade(280, '99.90', '1.5', 'sell', { lag: 10, id: 'p-early' })]
          : [trade(280, '99.90', '1.5', 'sell', { lag: 20, id: 'p-early' }), trade(264, '99.90', '1.2', 'sell', { lag: 486, id: 'p-late' })];
      const fx = makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '2' }), ...pre, trade(700, '99.90', '2.5', 'sell', { id: 'p-post' })], { durationMs: 3000 });
      return replay({
        fixture: fx,
        policy: fixedQuotePolicy({ bid: '99.90', qty: '1', pullTicks: [1] }),
        controller: null,
        config: testConfig({ steering: 'disabled' }),
      });
    };
    const inOrder = await run('in-order');
    const reversed = await run('reversed');
    const o2 = (r: Awaited<ReturnType<typeof run>>) => r.ledger.ofType('fill').filter((f) => f.orderId === 'o2').map((f) => [f.qty, f.queueAheadBefore, f.simTime - T0]);
    expect(o2(inOrder)).toEqual([['0.500000', '2.000000', 700]]);
    expect(o2(reversed)).toEqual(o2(inOrder));
    expect(inOrder.ledger.ofType('order_live').find((e) => e.orderId === 'o2')!.queueAhead).toBe('2.000000');
    expect(reversed.ledger.ofType('order_live').find((e) => e.orderId === 'o2')!.queueAhead).toBe('2.000000');
    for (const r of [inOrder, reversed]) {
      expect(Ledger.verify(r.ledger.all())).toEqual({ ok: true });
      const p = r.summary.portfolio;
      expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));
    }
  });
});
