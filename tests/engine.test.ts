import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PARAMS,
  DeterministicController,
  Ledger,
  MarketMakerPolicy,
  ScriptedController,
  baselineParams,
  buildRuns,
  generateSyntheticFixture,
  loadFixture,
  parseMoney,
  parseQty,
  replay,
  riskGateParams,
  serializeFixture,
  SCENARIOS,
  DEFAULT_POLICY,
  type Fixture,
  type LedgerEntry,
} from '../src/index.js';
import { T0, book, fixedQuotePolicy, flatBooks, makeFixture, stripHashes, testConfig, trade } from './helpers.js';

const baselineFixture = loadFixture('fixtures/synthetic-baseline.jsonl');
const riskFixture = loadFixture('fixtures/synthetic-riskgate.jsonl');

async function runScenario(name: 'baseline' | 'riskgate', kind: 'no_trade' | 'unsteered' | 'steered', fixture?: Fixture) {
  const scenario = SCENARIOS[name]!;
  const run = buildRuns(scenario).find((r) => r.kind === kind)!;
  return replay({ fixture: fixture ?? (name === 'baseline' ? baselineFixture : riskFixture), policy: run.policy, controller: run.controller, config: run.config });
}

describe('replay determinism', () => {
  it('produces byte-identical ledgers and summaries for both shipped scenarios and all three runs', async () => {
    for (const name of ['baseline', 'riskgate'] as const) {
      for (const kind of ['no_trade', 'unsteered', 'steered'] as const) {
        const a = await runScenario(name, kind);
        const b = await runScenario(name, kind);
        expect(a.ledger.headHash, `${name}/${kind} head`).toBe(b.ledger.headHash);
        expect(a.ledger.toJsonl(), `${name}/${kind} ledger`).toBe(b.ledger.toJsonl());
        expect(JSON.stringify(a.summary), `${name}/${kind} summary`).toBe(JSON.stringify(b.summary));
        expect(Ledger.verify(a.ledger.all()), `${name}/${kind} chain`).toEqual({ ok: true });
      }
    }
    const baselineSteered = await runScenario('baseline', 'steered');
    expect(baselineSteered.summary.windows).toBe(13);
    expect(baselineSteered.summary.windows).toBeGreaterThanOrEqual(10);
  });

  it('regenerates the committed fixtures byte-for-byte from their seeds', () => {
    expect(serializeFixture(generateSyntheticFixture(baselineParams()))).toBe(readFileSync('fixtures/synthetic-baseline.jsonl', 'utf8'));
    expect(serializeFixture(generateSyntheticFixture(riskGateParams()))).toBe(readFileSync('fixtures/synthetic-riskgate.jsonl', 'utf8'));
  });
});

describe('causality: future observations cannot change an earlier decision', () => {
  const cutoff = T0 + 15_000;

  function prefix(entries: readonly LedgerEntry[]) {
    return entries.filter((e) => e.type !== 'replay_started' && e.simTime <= cutoff).map(stripHashes);
  }

  it('is unaffected by rewriting or removing everything after the cutoff', async () => {
    const base = await runScenario('baseline', 'steered');

    const shifted: Fixture = {
      ...baselineFixture,
      events: baselineFixture.events.map((e) => {
        if (e.obsTime <= cutoff) return e;
        if (e.type === 'book') {
          return { ...e, bids: e.bids.map((l) => ({ ...l, price: l.price + 1_000_000n })), asks: e.asks.map((l) => ({ ...l, price: l.price + 1_000_000n })) };
        }
        return { ...e, price: e.price + 1_000_000n, aggressor: e.aggressor === 'sell' ? 'buy' : 'sell' };
      }),
    };
    const truncated: Fixture = {
      ...baselineFixture,
      header: { ...baselineFixture.header, eventCount: baselineFixture.events.filter((e) => e.obsTime <= cutoff).length },
      events: baselineFixture.events.filter((e) => e.obsTime <= cutoff),
    };
    const alt = await runScenario('baseline', 'steered', shifted);
    const cut = await runScenario('baseline', 'steered', truncated);

    const p = prefix(base.ledger.all());
    expect(p.length).toBeGreaterThan(500);
    expect(prefix(alt.ledger.all())).toEqual(p);
    expect(prefix(cut.ledger.all())).toEqual(p);
    // and the futures really did diverge
    expect(alt.ledger.headHash).not.toBe(base.ledger.headHash);
    expect(alt.summary.portfolio.netPnl).not.toBe(base.summary.portfolio.netPnl);
  });

  it('every policy decision cites a book observed no later than the decision time', async () => {
    const r = await runScenario('baseline', 'steered');
    for (const d of r.ledger.ofType('policy_decision')) {
      if (d.input.bookObsTime !== null) expect(d.input.bookObsTime).toBeLessThanOrEqual(d.simTime);
    }
    const obsById = new Map(r.ledger.ofType('observation').map((o) => [o.eventId, o]));
    for (const d of r.ledger.ofType('policy_decision')) {
      if (d.input.bookEventId) expect(obsById.get(d.input.bookEventId)!.obsTime).toBeLessThanOrEqual(d.simTime);
    }
  });
});

describe('outcomes are unavailable until their measurement horizon has elapsed', () => {
  it('a fill late in window 0 is pending at the window-0 review and measured by the window-1 review', async () => {
    const fx = makeFixture([...flatBooks(0, 6000, '100.00', '100.02'), trade(2800, '99.85', '0.5', 'sell')], { durationMs: 6000 });
    const controller = new ScriptedController({});
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller, config: testConfig() });

    const fills = r.ledger.ofType('fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.simTime).toBe(T0 + 2800);
    expect(fills[0]!.fillType).toBe('trade_through');

    const reviews = r.ledger.ofType('controller_input');
    expect(reviews).toHaveLength(2);
    const w0 = reviews[0]!.review;
    expect(w0.window.end).toBe(T0 + 3000);
    expect(w0.activity.fills).toBe(1);
    expect(w0.outcomes.measuredThisWindow.map((o) => o.count)).toEqual([0, 0]);
    expect(w0.outcomes.pendingAtWindowEnd).toBe(2);
    // what the controller actually received is what was logged
    expect(controller.calls[0]!.review).toEqual(w0);

    const w1 = reviews[1]!.review;
    expect(w1.outcomes.measuredThisWindow.map((o) => o.count)).toEqual([1, 1]);
    expect(w1.outcomes.pendingAtWindowEnd).toBe(0);

    const outcomes = r.ledger.ofType('outcome');
    expect(outcomes.map((o) => [o.horizonMs, o.availableAt - o.sourceMarketTime, o.simTime === o.availableAt])).toEqual([
      [1000, 1000, true],
      [3000, 3000, true],
    ]);
    // markout for a buy at 99.90 vs mid 100.01 over 0.5 units = +0.055
    expect(outcomes[0]!.markout).toBe('0.055000');
    expect(outcomes[0]!.status).toBe('measured');
  });

  it('a fill whose horizon extends past the end of the replay stays pending', async () => {
    const fx = makeFixture([...flatBooks(0, 3000, '100.00', '100.02'), trade(2800, '99.85', '0.5', 'sell')], { durationMs: 3000 });
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.summary.fills.count).toBe(1);
    expect(r.summary.outcomesPendingAtEnd).toBe(2);
    expect(r.ledger.ofType('outcome')).toHaveLength(0);
  });
});

describe('steering takes effect only in the next window', () => {
  const books = flatBooks(0, 9000, '100.00', '100.02');

  it('an instruction produced after window 0 applies from the first tick of window 1, never inside window 0', async () => {
    const controller = new ScriptedController({ 0: { kind: 'params', params: { quoteSides: 'none' }, reason: 'stop quoting' } });
    const policy = new MarketMakerPolicy(DEFAULT_POLICY);
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy, controller, config: testConfig() });

    const accepted = r.ledger.ofType('instruction_accepted');
    expect(accepted[0]!.instruction.version).toBe(1);
    expect(accepted[0]!.instruction.effectiveFrom).toBe(T0 + 3000);
    expect(accepted[0]!.simTime).toBe(T0 + 3000);
    expect(accepted[0]!.appliesFrom).toBe(T0 + 3000);

    const decisions = r.ledger.ofType('policy_decision');
    const w0 = decisions.filter((d) => d.simTime < T0 + 3000);
    const w1 = decisions.filter((d) => d.simTime >= T0 + 3000 && d.simTime < T0 + 6000);
    expect(w0).toHaveLength(10);
    expect(w1).toHaveLength(10);
    expect(w0.every((d) => d.instructionVersion === 0)).toBe(true);
    expect(w0.every((d) => d.decision.bid !== null && d.decision.ask !== null)).toBe(true);
    expect(w1.every((d) => d.instructionVersion === 1)).toBe(true);
    expect(w1.every((d) => d.decision.bid === null && d.decision.ask === null)).toBe(true);
    // resting orders from window 0 get withdrawn at the first tick of window 1
    const cancels = r.ledger.ofType('cancel_requested').filter((c) => c.simTime === T0 + 3000);
    expect(cancels.length).toBeGreaterThan(0);
  });

  it('the controller runs exactly once per completed window, at the boundary, never on the tick path', async () => {
    const controller = new ScriptedController({});
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller, config: testConfig() });
    expect(controller.calls.map((c) => c.review.window.end)).toEqual([T0 + 3000, T0 + 6000]);
    expect(controller.calls.map((c) => c.ctx.nextWindow.start)).toEqual([T0 + 3000, T0 + 6000]);
    expect(r.summary.ticks).toBe(30);
    const inputs = r.ledger.ofType('controller_input');
    const outputs = r.ledger.ofType('controller_output');
    for (const o of outputs) {
      // the output entry sits at the boundary and before the first decision of the next window
      const nextDecision = r.ledger.all().find((e) => e.ledgerSeq > o.ledgerSeq && e.type === 'policy_decision')!;
      expect(nextDecision.simTime).toBe(o.simTime);
      expect(o.simTime % 3000).toBe(T0 % 3000);
    }
    expect(inputs).toHaveLength(3); // last window is reviewed and logged but no controller call follows
    expect(r.ledger.ofType('controller_skipped').map((s) => s.reason)).toEqual(['no_next_window']);
  });

  it('a controller with modeled latency applies from the first tick at or after it is ready', async () => {
    const controller = new ScriptedController({ 0: { kind: 'params', params: { quoteSides: 'none' }, latencyMs: 100 } });
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller, config: testConfig() });
    const acc = r.ledger.ofType('instruction_accepted')[0]!;
    expect(acc.readyAt).toBe(T0 + 3100);
    expect(acc.appliesFrom).toBe(T0 + 3100);
    const d = r.ledger.ofType('policy_decision');
    expect(d.find((x) => x.simTime === T0 + 3000)!.instructionVersion).toBe(0);
    expect(d.find((x) => x.simTime === T0 + 3300)!.instructionVersion).toBe(1);
    const w1 = r.ledger.ofType('window_summary').find((w) => w.window === 1)!;
    expect(w1.instructionVersionsUsed).toEqual([0, 1]);
  });

  it('a late controller response is discarded and the prior instruction stays in force', async () => {
    const controller = new ScriptedController({ 0: { kind: 'params', params: { quoteSides: 'none' }, latencyMs: 500 } });
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller, config: testConfig({ controllerDeadlineMs: 200 }) });
    const rej = r.ledger.ofType('instruction_rejected');
    expect(rej.map((x) => [x.window, x.reason, x.keptInstructionVersion])).toEqual([[0, 'late', 0]]);
    // only window 0's proposal was late; window 1's on-time proposal becomes v1
    expect(r.ledger.ofType('instruction_accepted').map((a) => [a.instruction.version, a.instruction.basedOnWindow])).toEqual([[1, 1]]);
    const w1 = r.ledger.ofType('policy_decision').filter((d) => d.simTime >= T0 + 3000 && d.simTime < T0 + 6000);
    expect(w1.every((d) => d.instructionVersion === 0 && d.decision.bid !== null)).toBe(true);
    // the next accepted instruction still expects version 1
    expect(controller.calls[1]!.ctx.nextVersion).toBe(1);
  });

  it('a failed controller keeps the prior instruction', async () => {
    const controller = new ScriptedController({ 0: { kind: 'throw', message: 'model unavailable' } });
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller, config: testConfig() });
    expect(r.ledger.ofType('instruction_rejected').map((x) => [x.reason, x.detail])).toEqual([['controller_failed', 'model unavailable']]);
    expect(r.summary.instructions.finalVersion).toBe(1); // window 1's review produced v1 normally
    expect(r.summary.instructions.history.map((h) => h.basedOnWindow)).toEqual([-1, 1]);
  });

  it('out-of-contract instructions are rejected as invalid', async () => {
    const good = (ctxVersion: number, effectiveFrom: number, basedOnWindow: number, extra: object = {}) => ({
      schemaVersion: 1,
      version: ctxVersion,
      controllerId: 'raw',
      basedOnWindow,
      issuedAt: 0,
      effectiveFrom,
      params: { ...DEFAULT_PARAMS, ...extra },
      reason: 'raw',
    });
    const controller = new ScriptedController({
      0: { kind: 'raw', instruction: good(1, T0 + 3000, 0, { spreadMultiplierMilli: 9000 }) },
      1: { kind: 'raw', instruction: good(7, T0 + 6000, 1) },
      2: { kind: 'raw', instruction: good(1, T0 + 12000, 2) },
      3: { kind: 'raw', instruction: { ...good(1, T0 + 12000, 3), params: { ...DEFAULT_PARAMS, quoteSides: 'sideways' } } },
      4: { kind: 'raw', instruction: 'not an object' },
      5: { kind: 'raw', instruction: good(1, T0 + 18000, 5, { sizeMultiplierMilli: 1.5 }) },
    });
    const fx = makeFixture(flatBooks(0, 21000, '100.00', '100.02'), { durationMs: 21000 });
    const r = await replay({ fixture: fx, policy: new MarketMakerPolicy(DEFAULT_POLICY), controller, config: testConfig() });
    const rej = r.ledger.ofType('instruction_rejected');
    expect(rej.map((x) => x.reason)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(rej[0]!.detail).toMatch(/spreadMultiplierMilli=9000 outside/);
    expect(rej[1]!.detail).toMatch(/version must be 1/);
    expect(rej[2]!.detail).toMatch(/effectiveFrom must be/);
    expect(rej[3]!.detail).toMatch(/quoteSides/);
    expect(rej[4]!.detail).toMatch(/not an object/);
    expect(rej[5]!.detail).toMatch(/sizeMultiplierMilli must be an integer/);
    expect(r.summary.instructions.finalVersion).toBe(0);
  });
});

describe('steering demonstrably changes the next window', () => {
  it('steered and unsteered runs agree until the first non-default instruction applies, then diverge', async () => {
    const steered = await runScenario('baseline', 'steered');
    const unsteered = await runScenario('baseline', 'unsteered');
    const firstChange = steered.summary.instructions.history.find((h) => JSON.stringify(h.params) !== JSON.stringify(DEFAULT_PARAMS))!;
    expect(firstChange).toBeDefined();
    const appliesFrom = Math.max(firstChange.effectiveFrom, firstChange.readyAt);
    expect(appliesFrom % 3000).toBe(T0 % 3000); // a window boundary

    const quotes = (r: typeof steered) => r.ledger.ofType('policy_decision').map((d) => ({ t: d.simTime, bid: d.decision.bid, ask: d.decision.ask }));
    const before = (q: ReturnType<typeof quotes>) => q.filter((x) => x.t < appliesFrom);
    const after = (q: ReturnType<typeof quotes>) => q.filter((x) => x.t >= appliesFrom);
    expect(before(quotes(steered))).toEqual(before(quotes(unsteered)));
    expect(after(quotes(steered))).not.toEqual(after(quotes(unsteered)));
    expect(unsteered.summary.instructions.finalVersion).toBe(0);
    expect(steered.summary.instructions.accepted).toBe(12);
    expect(steered.summary.instructions.rejectedLate + steered.summary.instructions.rejectedFailed + steered.summary.instructions.rejectedInvalid).toBe(0);

    // the changed window really used different parameters
    const w = steered.summary.windowRows.find((x) => x.start === appliesFrom)!;
    expect(w.params.spreadMultiplierMilli).not.toBe(DEFAULT_PARAMS.spreadMultiplierMilli);
  });

  it('the no-trade baseline trades nothing and pays nothing', async () => {
    const r = await runScenario('baseline', 'no_trade');
    expect(r.summary.fills.count).toBe(0);
    expect(r.summary.orders.proposed).toBe(0);
    expect(r.summary.portfolio.netPnl).toBe('0.000000');
    expect(r.summary.portfolio.txCostsPaid).toBe('0.000000');
  });
});

describe('net P&L reconciles with inventory, cash, fees and modeled execution costs', () => {
  for (const [name, kind] of [
    ['baseline', 'steered'],
    ['baseline', 'unsteered'],
    ['riskgate', 'unsteered'],
  ] as const) {
    it(`${name}/${kind}: ledger fills and costs rebuild the summary exactly`, async () => {
      const r = await runScenario(name, kind);
      const fills = r.ledger.ofType('fill');
      const tx = r.ledger.ofType('tx_cost');
      expect(fills.length).toBeGreaterThan(0);

      let cash = parseMoney(r.summary.portfolio.initialCash);
      let inv = 0n;
      let fees = 0n;
      let txTotal = 0n;
      let buyN = 0n;
      let sellN = 0n;
      for (const f of fills) {
        const n = parseMoney(f.notional);
        const fee = parseMoney(f.fee);
        cash += f.side === 'buy' ? -n : n;
        cash -= fee;
        fees += fee;
        inv += f.side === 'buy' ? parseQty(f.qty) : -parseQty(f.qty);
        if (f.side === 'buy') buyN += n;
        else sellN += n;
        expect(parseQty(f.inventoryAfter)).toBe(inv);
      }
      for (const t of tx) {
        cash -= parseMoney(t.amount);
        txTotal += parseMoney(t.amount);
      }
      const p = r.summary.portfolio;
      expect(parseMoney(p.cash)).toBe(cash);
      expect(parseQty(p.inventory)).toBe(inv);
      expect(parseMoney(p.feesPaid)).toBe(fees);
      expect(parseMoney(p.txCostsPaid)).toBe(txTotal);
      expect(parseMoney(r.summary.fills.buyNotional)).toBe(buyN);
      expect(parseMoney(r.summary.fills.sellNotional)).toBe(sellN);
      const realized = fills.reduce((s, f) => s + parseMoney(f.realizedDelta), 0n);
      expect(parseMoney(p.grossRealized)).toBe(realized);
      // identity
      expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - fees - txTotal);
      expect(parseMoney(p.equity)).toBe(cash + parseMoney(p.inventoryValue));
      expect(parseMoney(p.netPnl)).toBe(parseMoney(p.equity) - parseMoney(p.initialCash));
      // tx costs: one per submission and one per cancel request
      expect(tx.filter((t) => t.kind === 'placement')).toHaveLength(r.summary.orders.submitted);
      expect(tx.filter((t) => t.kind === 'cancel')).toHaveLength(r.summary.orders.cancelsRequested);
    });
  }
});

describe('risk gate inside the replay', () => {
  it('the risk-gate fixture produces position-limit rejections and a loss-limit kill switch', async () => {
    // Steered run: the controller shrinks size, the policy keeps proposing bids near the cap and the gate blocks them
    // (open replace-in-flight exposure counts). Unsteered: the policy's own inventory cap stops proposals first.
    const s = await runScenario('riskgate', 'steered');
    const positionRejects = s.ledger.ofType('order_rejected').filter((o) => o.rejectedBy === 'risk_gate' && o.reason === 'position_limit');
    expect(positionRejects.length).toBeGreaterThan(0);
    expect(positionRejects[0]!.detail).toMatch(/exceeds max position 2/);

    const r = await runScenario('riskgate', 'unsteered');
    const breach = r.ledger.ofType('risk_breach');
    expect(breach).toHaveLength(1);
    expect(parseMoney(breach[0]!.netPnl)).toBeLessThanOrEqual(parseMoney('-3'));
    const after = r.ledger.all().filter((e) => e.ledgerSeq > breach[0]!.ledgerSeq);
    expect(after.some((e) => e.type === 'order_submitted')).toBe(false);
    expect(after.some((e) => e.type === 'order_rejected' && e.reason === 'kill_switch_active')).toBe(true);
    expect(r.summary.risk.killSwitchTripped).toBe(true);
    expect(parseQty(r.summary.portfolio.maxAbsInventory)).toBeLessThanOrEqual(parseQty('2'));
  });

  it('the steered run halts quoting after the kill switch instead of proposing orders that get rejected', async () => {
    const r = await runScenario('riskgate', 'steered');
    const breach = r.ledger.ofType('risk_breach')[0]!;
    const halt = r.ledger.ofType('instruction_accepted').find((i) => i.instruction.params.quoteSides === 'none')!;
    expect(halt.simTime).toBeGreaterThan(breach.simTime);
    const afterHalt = r.ledger.ofType('order_proposed').filter((o) => o.simTime >= halt.appliesFrom);
    expect(afterHalt).toHaveLength(0);
  });

  it('a position limit blocks a trade in a hand-built fixture', async () => {
    const fx = makeFixture(
      [
        ...flatBooks(0, 6000, '100.00', '100.02', 100, { bidSize: '0' }),
        trade(1000, '99.80', '5', 'sell'),
        trade(2000, '99.80', '5', 'sell'),
        trade(4000, '99.80', '5', 'sell'),
      ],
      { durationMs: 6000 },
    );
    const cfg = testConfig({ steering: 'disabled', risk: { ...testConfig().risk, maxPosition: parseQty('2'), maxOrderQty: parseQty('1') } });
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: cfg });
    // each fill re-arms a new quote; after two fills the third proposal breaches the position limit
    expect(r.summary.fills.count).toBe(2);
    expect(parseQty(r.summary.portfolio.inventory)).toBe(parseQty('2'));
    const rej = r.ledger.ofType('order_rejected').filter((o) => o.reason === 'position_limit');
    expect(rej.length).toBeGreaterThan(0);
    expect(rej[0]!.detail).toMatch(/exceeds max position 2/);
  });
});

describe('touch vs fill and races at engine level', () => {
  it('a book touch never fills; a print at our price fills only past the queue ahead', async () => {
    const fx = makeFixture(
      [
        book(0, '99.90', '99.92', { bidSize: '2' }),
        ...flatBooks(100, 900, '99.90', '99.92', 100, { bidSize: '2' }),
        trade(1000, '99.90', '0.5', 'sell'), // queue 2 -> 1.5
        ...flatBooks(1100, 1900, '99.80', '99.90', 100, { bidSize: '2' }), // ask touches our bid: no fill
        trade(2000, '99.90', '2.0', 'sell'), // queue 1.5 -> 0, fill 0.5
        ...flatBooks(2100, 2900, '99.90', '99.92', 100, { bidSize: '2' }),
      ],
      { durationMs: 3000 },
    );
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    const fills = r.ledger.ofType('fill');
    expect(fills.map((f) => [f.simTime - T0, f.qty, f.fillType, f.isPartial])).toEqual([[2000, '0.500000', 'queue_exhausted', true]]);
    expect(r.ledger.ofType('queue_consumed')).toHaveLength(1);
    expect(r.ledger.ofType('order_live')[0]!.queueAhead).toBe('2.000000');
  });

  it('cancel/fill race is resolved consistently and each order reaches exactly one terminal state', async () => {
    const mk = (tradeAt: number) =>
      makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(tradeAt, '99.80', '1', 'sell')], { durationMs: 3000 });
    // quote from tick 0 (order live at 50), pull at tick 3 (t=900): cancel effective at 950
    const run = (tradeAt: number) => replay({ fixture: mk(tradeAt), policy: fixedQuotePolicy({ bid: '99.90', qty: '1', pullFromTick: 3 }), controller: null, config: testConfig({ steering: 'disabled' }) });
    const before = await run(930);
    const tie = await run(950);
    const after = await run(951);
    expect(before.summary.fills.count).toBe(1);
    expect(before.ledger.ofType('cancel_fill_race')).toHaveLength(1);
    expect(before.ledger.ofType('cancel_too_late').map((c) => c.reason)).toEqual(['already_filled']);
    expect(tie.summary.fills.count).toBe(1);
    expect(tie.ledger.ofType('cancel_fill_race')[0]!.outcome).toBe('fill_wins_tie');
    expect(before.ledger.ofType('cancel_fill_race')[0]!.outcome).toBe('fill_wins_before_cancel');
    expect(after.summary.fills.count).toBe(0);
    expect(after.ledger.ofType('cancel_effective')).toHaveLength(1);
    for (const r of [before, tie, after]) {
      const terminal = r.ledger.all().filter((e) => e.type === 'cancel_effective' || (e.type === 'fill' && !e.isPartial) || e.type === 'order_rejected');
      expect(terminal).toHaveLength(1);
      expect((await run(r === before ? 930 : r === tie ? 950 : 951)).ledger.headHash).toBe(r.ledger.headHash);
    }
  });
});

describe('venue-time fill eligibility inside the replay', () => {
  // Books every 100 ms with zero feed lag; the scripted policy rests a bid at 99.90 from tick 0 (live at t=50).
  const books = flatBooks(0, 3000, '100.00', '100.02');

  it('a trade that predates activation but arrives afterwards cannot fill; later prints fill at observation time', async () => {
    const fx = makeFixture(
      [
        ...books,
        trade(30, '99.80', '0.4', 'sell', { lag: 40 }), // printed 30 (< liveAt 50), observed 70 (order live by then)
        trade(60, '99.80', '0.3', 'sell', { lag: 40 }), // printed 60, observed 100
        trade(940, '99.80', '0.2', 'sell', { lag: 100 }), // printed before the cancel takes effect at 950, observed 1040
        trade(960, '99.80', '0.2', 'sell', { lag: 100 }), // printed after the cancel took effect
      ],
      { durationMs: 3000 },
    );
    const policy = fixedQuotePolicy({ bid: '99.90', qty: '1', pullFromTick: 3 }); // pull at t=900 -> cancel effective 950
    const r = await replay({ fixture: fx, policy, controller: null, config: testConfig({ steering: 'disabled' }) });

    const fills = r.ledger.ofType('fill');
    expect(fills.map((f) => [f.simTime - T0, f.sourceMarketTime - T0, f.qty, f.afterCancelEffective])).toEqual([
      [100, 60, '0.300000', false],
      [1040, 940, '0.200000', true],
    ]);
    expect(fills.every((f) => f.observedAt === f.simTime)).toBe(true);
    const inel = r.ledger.ofType('fill_ineligible');
    expect(inel.map((e) => [e.simTime - T0, e.tradeMarketTime - T0, e.reason])).toEqual([
      [70, 30, 'predates_activation'],
      [1060, 960, 'after_cancellation'],
    ]);
    expect(r.ledger.ofType('cancel_fill_race').map((c) => c.outcome)).toEqual(['late_fill_after_cancel_effective']);
    expect(r.summary.fills).toMatchObject({ count: 2, lateAfterCancel: 1, ineligible: 2, uncertain: 0 });

    // the strategy learns about each fill at its observation time, not before
    const decisions = r.ledger.ofType('policy_decision');
    const invAt = (t: number) => decisions.find((d) => d.simTime === T0 + t)!.input.inventory;
    expect(invAt(0)).toBe('0.000000');
    expect(invAt(300)).toBe('0.300000');
    expect(invAt(900)).toBe('0.300000');
    expect(invAt(1200)).toBe('0.500000');

    // outcomes run on venue time and cannot precede the observation of the fill
    const outcomes = r.ledger.ofType('outcome').filter((o) => o.horizonMs === 1000);
    expect(outcomes.map((o) => [o.sourceMarketTime - T0, o.observedAt - T0, o.availableAt - T0, o.midSelection])).toEqual([
      [60, 100, 1060, 'venue_time'],
      [940, 1040, 1940, 'venue_time'],
    ]);
    expect(outcomes.every((o) => o.midMarketTime! <= o.sourceMarketTime + o.horizonMs)).toBe(true);

    // accounting identity still holds with late fills
    const p = r.summary.portfolio;
    expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));
  });

  it('a late fill on a provisionally cancelled order can overrun the position limit; it is logged and further increases are blocked', async () => {
    const fx = makeFixture(
      [
        ...books,
        trade(60, '99.80', '0.3', 'sell', { lag: 40 }), // fills 0.3 of order 1 at obs 100
        trade(940, '99.80', '0.7', 'sell', { lag: 360 }), // printed while order 1 was live, observed at 1300 after its cancel (950)
        trade(1300, '99.80', '1', 'sell'), // fills order 2 (live at 1250)
      ],
      { durationMs: 3000 },
    );
    const policy = fixedQuotePolicy({ bid: '99.90', qty: '1', pullTicks: [3] }); // pull only at t=900, requote from t=1200
    const cfg = testConfig({ steering: 'disabled', risk: { ...testConfig().risk, maxPosition: parseQty('1.5'), maxOrderQty: parseQty('1') } });
    const r = await replay({ fixture: fx, policy, controller: null, config: cfg });

    const fills = r.ledger.ofType('fill');
    expect(fills.map((f) => [f.orderId, f.simTime - T0, f.qty, f.afterCancelEffective])).toEqual([
      ['o1', 100, '0.300000', false],
      ['o1', 1300, '0.700000', true],
      ['o2', 1300, '1.000000', false],
    ]);
    expect(parseQty(r.summary.portfolio.inventory)).toBe(parseQty('2'));
    const overruns = r.ledger.ofType('risk_breach').filter((b) => b.kind === 'position_overrun');
    expect(overruns).toHaveLength(1);
    expect(overruns[0]!.simTime).toBe(T0 + 1300);
    expect(r.summary.risk.positionOverruns).toBe(1);
    // the next proposal is blocked by the position limit; nothing else is submitted
    const later = r.ledger.all().filter((e) => e.simTime > T0 + 1300);
    expect(later.some((e) => e.type === 'order_rejected' && e.reason === 'position_limit')).toBe(true);
    expect(later.some((e) => e.type === 'order_submitted')).toBe(false);
  });
});

describe('order-linked uncertainty and zero latency in a full replay', () => {
  it('a stale-discarded print that was eligible for a resting order is logged as fill_uncertain and never filled', async () => {
    const fx = makeFixture(
      [
        ...flatBooks(0, 3000, '100.00', '100.02'),
        trade(100, '99.80', '1', 'sell', { lag: 600 }), // printed while live (liveAt 50), observed at 700 with lag > 500 -> stale
        trade(1500, '99.80', '0.2', 'sell', { lag: 100 }), // ordinary print: fills
      ],
      { durationMs: 3000 },
    );
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled', maxStalenessMs: 500 }) });
    expect(r.ledger.ofType('observation_rejected').map((x) => [x.reason, x.simTime - T0])).toEqual([['stale_observation', 700]]);
    const unc = r.ledger.ofType('fill_uncertain');
    expect(unc.map((u) => [u.simTime - T0, u.orderId, u.reason, u.lagMs, u.tradeMarketTime - T0])).toEqual([[700, 'o1', 'stale_print_discarded', 600, 100]]);
    expect(r.ledger.ofType('fill').map((f) => [f.simTime - T0, f.qty])).toEqual([[1600, '0.200000']]);
    expect(r.summary.fills).toMatchObject({ count: 1, uncertain: 1 });
    // the ledger position of the doubt is chronological and sits next to the rejection it stems from
    const rej = r.ledger.ofType('observation_rejected')[0]!;
    expect(unc[0]!.ledgerSeq).toBe(rej.ledgerSeq + 1);
  });

  it('zero order and cancel latency replays cleanly: live at submission, cancelled at request', async () => {
    const fx = makeFixture([...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }), trade(1000, '99.80', '1', 'sell')], { durationMs: 3000 });
    const cfg = testConfig({ steering: 'disabled', execution: { ...testConfig().execution, orderLatencyMs: 0, cancelLatencyMs: 0 } });
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1', pullTicks: [2] }), controller: null, config: cfg });
    const submitted = r.ledger.ofType('order_submitted')[0]!;
    const live = r.ledger.ofType('order_live')[0]!;
    expect(live.liveAt).toBe(submitted.submittedAt);
    expect(live.ledgerSeq).toBe(submitted.ledgerSeq + 2); // submitted, tx_cost, live: same instant
    const cancelReq = r.ledger.ofType('cancel_requested')[0]!;
    const cancelEff = r.ledger.ofType('cancel_effective')[0]!;
    expect(cancelReq.expectedEffectiveAt).toBe(cancelReq.requestedAt);
    expect(cancelEff.simTime).toBe(cancelReq.requestedAt);
    // the order re-placed at tick 3 (t=900) is live immediately and the print at t=1000 fills it
    expect(r.ledger.ofType('fill').map((f) => [f.simTime - T0, f.qty])).toEqual([[1000, '1.000000']]);
    expect(r.summary.orders.rejectedByVenue).toBe(0);
  });

  it('non-integer latencies are rejected at configuration time with a clear message', async () => {
    const cfg = testConfig({ execution: { ...testConfig().execution, orderLatencyMs: 12.5 } });
    await expect(replay({ fixture: makeFixture(flatBooks(0, 3000, '100.00', '100.02'), { durationMs: 3000 }), policy: fixedQuotePolicy({}), controller: null, config: cfg })).rejects.toThrow(
      /execution\.orderLatencyMs must be a non-negative integer/,
    );
  });
});

describe('chronological ledger: a bad event later in the stream leaves no earlier trace', () => {
  const cutoff = T0 + 15_000;
  const prefix = (entries: readonly LedgerEntry[]) => entries.filter((e) => e.type !== 'replay_started' && e.simTime <= cutoff).map(stripHashes);

  it('a future event that is malformed is rejected at its own observation time', async () => {
    const base = await runScenario('baseline', 'steered');
    const idx = baselineFixture.events.findIndex((e) => e.type === 'book' && e.obsTime > cutoff + 3000);
    const target = baselineFixture.events[idx]! as Extract<Fixture['events'][number], { type: 'book' }>;
    const crossed: Fixture = {
      ...baselineFixture,
      events: baselineFixture.events.map((e, i) => (i === idx ? { ...target, bids: target.bids.map((l) => ({ ...l, price: l.price + 1_000_000n })) } : e)),
    };
    const r = await runScenario('baseline', 'steered', crossed);
    expect(prefix(r.ledger.all())).toEqual(prefix(base.ledger.all()));
    const rej = r.ledger.ofType('observation_rejected');
    expect(rej.map((x) => [x.eventId, x.reason, x.simTime, x.encounteredAt])).toEqual([[target.eventId, 'crossed_book', target.obsTime, target.obsTime]]);
    expect(rej[0]!.simTime).toBeGreaterThan(cutoff);
    // nothing about the bad event precedes the decisions taken before it arrived
    const firstDecisionAfter = r.ledger.ofType('policy_decision').find((d) => d.simTime > target.obsTime)!;
    expect(rej[0]!.ledgerSeq).toBeLessThan(firstDecisionAfter.ledgerSeq);
    expect(r.ledger.all().filter((e) => e.simTime < target.obsTime).some((e) => e.type === 'observation_rejected')).toBe(false);
  });

  it('a future event that arrives out of order is rejected when encountered, after the stream has passed it', async () => {
    const base = await runScenario('baseline', 'steered');
    const idx = baselineFixture.events.findIndex((e) => e.obsTime > cutoff + 3000);
    const target = baselineFixture.events[idx]!;
    const prev = baselineFixture.events[idx - 1]!;
    const newObs = target.obsTime - 1500;
    const moved: Fixture = {
      ...baselineFixture,
      events: baselineFixture.events.map((e, i) => (i === idx ? { ...e, obsTime: newObs, marketTime: Math.min(e.marketTime, newObs) } : e)),
    };
    const r = await runScenario('baseline', 'steered', moved);
    expect(prefix(r.ledger.all())).toEqual(prefix(base.ledger.all()));
    const rej = r.ledger.ofType('observation_rejected');
    expect(rej.map((x) => [x.eventId, x.reason])).toEqual([[target.eventId, 'out_of_order']]);
    // logged at the stream position it was encountered at (the previous event's obsTime), never at replay start
    expect(rej[0]!.simTime).toBe(prev.obsTime);
    expect(rej[0]!.encounteredAt).toBe(prev.obsTime);
    expect(rej[0]!.obsTime).toBe(newObs);
    expect(rej[0]!.simTime).toBeGreaterThan(rej[0]!.obsTime);
    expect(r.summary.observations.accepted).toBe(base.summary.observations.accepted - 1);
  });

  it('every rejection in the shipped fixtures and their variants is logged no earlier than the event itself', async () => {
    for (const r of [await runScenario('baseline', 'steered'), await runScenario('riskgate', 'unsteered')]) {
      for (const rej of r.ledger.ofType('observation_rejected')) {
        expect(rej.simTime).toBeGreaterThanOrEqual(Math.min(rej.obsTime, rej.encounteredAt));
        expect(rej.simTime).toBe(rej.encounteredAt);
      }
      // only events observed after the replay end are never reached
      const fx = r.summary.fixture.seed === 42 ? baselineFixture : riskFixture;
      const end = fx.header.startTime + r.summary.windows * r.summary.windowMs;
      expect(r.summary.observations.notReached).toBe(fx.events.filter((e) => e.obsTime > end).length);
    }
  });
});

describe('deterministic controller', () => {
  it('widens after adverse markouts and halts when the kill switch is active', async () => {
    const c = new DeterministicController();
    const steered = await runScenario('baseline', 'steered');
    const adverse = steered.ledger.ofType('controller_input').find((i) => i.review.outcomes.measuredThisWindow[0]!.count > 0 && i.review.outcomes.measuredThisWindow[0]!.sumMarkout.startsWith('-'))!;
    const prior = steered.summary.instructions.history.find((h) => h.version === adverse.window)!;
    const ctx = { priorInstruction: { ...steered.summary.instructions.history[0]!, schemaVersion: 1 as const, params: prior.params, reason: '', issuedAt: 0 }, nextWindow: { index: adverse.window + 1, start: adverse.review.window.end, end: adverse.review.window.end + 3000 }, nextVersion: adverse.window + 1, bounds: (await import('../src/index.js')).INSTRUCTION_BOUNDS, deadlineMs: 200 };
    const out = await c.decide(adverse.review, ctx);
    expect(out.instruction.params.spreadMultiplierMilli).toBeGreaterThan(prior.params.spreadMultiplierMilli);
    expect(out.instruction.params.sizeMultiplierMilli).toBeLessThan(prior.params.sizeMultiplierMilli);
    const halted = { ...adverse.review, risk: { ...adverse.review.risk, killSwitchActive: true } };
    const h = await c.decide(halted, ctx);
    expect(h.instruction.params.quoteSides).toBe('none');
  });
});
