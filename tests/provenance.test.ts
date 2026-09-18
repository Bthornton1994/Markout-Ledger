import { describe, expect, it } from 'vitest';
import { parseMoney, replay } from '../src/index.js';
import { T0, fixedQuotePolicy, flatBooks, makeFixture, testConfig, trade } from './helpers.js';

/**
 * Mirror of audit Case B, with a mid that moves between the two source prints' markout horizons.
 *   P: at our price 99.90, size 1.0, venue 200, observed 250  -> absorbed by the displayed queue (2.0 -> 1.0)
 *   Q: through our price, size 0.5, venue 100, observed 300   -> in venue order Q sweeps the level first (fills 0.5),
 *                                                                then P finds no queue and fills the remaining 0.5
 * Books: touch 99.90/99.92 (mid 99.91) until t=1100, then 100.90/100.92 (mid 100.91) from t=1150. One-second
 * horizons: Q's portion at 1100 (mid 99.91), P's portion at 1200 (mid 100.91). Each awarded quantity must cite its own source print and venue time, no print
 * may be credited beyond its size, and both quantities become known only when Q is observed at 300.
 */
function mirrorFixture() {
  return makeFixture(
    [
      ...flatBooks(0, 1100, '99.90', '99.92', 100, { bidSize: '2' }),
      ...flatBooks(1150, 3000, '100.90', '100.92', 100, { bidSize: '2' }),
      trade(200, '99.90', '1.0', 'sell', { lag: 50 }), // P
      trade(100, '99.85', '0.5', 'sell', { lag: 200 }), // Q
    ],
    { durationMs: 3000 },
  );
}

describe('fill provenance under venue re-ordering', () => {
  it('mirror case: each awarded quantity cites its actual source print and venue time, known only at the later observation', async () => {
    const fx = mirrorFixture();
    const idOf = (marketOffset: number) => fx.events.find((e) => e.type === 'trade' && e.marketTime === T0 + marketOffset)!.eventId;
    const P = idOf(200);
    const Q = idOf(100);
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });

    const fills = r.ledger.ofType('fill');
    expect(fills.map((f) => [f.simTime - T0, f.sourceTradeEventId, f.sourceMarketTime - T0, f.qty, f.fillType, f.establishedByTradeEventId])).toEqual([
      [300, Q, 100, '0.500000', 'trade_through', Q], // Q's own 0.5
      [300, P, 200, '0.500000', 'queue_exhausted', Q], // P's 0.5, established by observing Q
    ]);
    // no source print credited beyond its size
    for (const f of fills) expect(parseMoney(f.qty) <= parseMoney(f.sourceTradeSize)).toBe(true);
    expect(fills.every((f) => f.observedAt === f.simTime)).toBe(true);
    // nothing about either quantity is known before Q is observed
    expect(r.ledger.all().filter((e) => e.simTime < T0 + 300 && e.type === 'fill')).toHaveLength(0);
    const decisions = r.ledger.ofType('policy_decision');
    expect(decisions.find((d) => d.simTime === T0 + 0)!.input.inventory).toBe('0.000000');
    expect(decisions.find((d) => d.simTime === T0 + 300)!.input.inventory).toBe('1.000000');
    expect(r.ledger.ofType('queue_consumed').map((q) => [q.simTime - T0, q.tradeEventId])).toEqual([[250, P]]);

    // outcomes run from each portion's own source venue time and read the mid of that horizon
    const outcomes = r.ledger.ofType('outcome').filter((o) => o.horizonMs === 1000);
    expect(outcomes.map((o) => [o.sourceTradeEventId, o.sourceMarketTime - T0, o.availableAt - T0, o.qty, o.midAtHorizon, o.markout])).toEqual([
      [Q, 100, 1100, '0.500000', '99.910000', '0.005000'],
      [P, 200, 1200, '0.500000', '100.910000', '0.505000'],
    ]);
    expect(r.summary.outcomes[0]).toMatchObject({ horizonMs: 1000, count: 2, sumMarkout: '0.510000' });

    // accounting still reconciles from the fill entries alone
    const p = r.summary.portfolio;
    expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));
    expect(r.summary.fills.count).toBe(2);
    expect(r.summary.fills.qty).toBe('1.000000');
    expect(r.summary.fills.establishedByReordering).toBe(1);
  });

  it('re-split case: already-booked quantity keeps its accounting but its provenance and pending horizons move to the actual source', async () => {
    // B: through 99.85, size 1.0, venue 200, observed 250 -> books 1.0 from B
    // A: through 99.85, size 0.5, venue 100, observed 300 -> in venue order A fills 0.5 first, B only 0.5
    const fx = makeFixture(
      [
        ...flatBooks(0, 1100, '99.90', '99.92', 100, { bidSize: '0' }),
        ...flatBooks(1150, 3000, '100.90', '100.92', 100, { bidSize: '0' }),
        trade(200, '99.85', '1.0', 'sell', { lag: 50 }), // B
        trade(100, '99.85', '0.5', 'sell', { lag: 200 }), // A
      ],
      { durationMs: 3000 },
    );
    const idOf = (marketOffset: number) => fx.events.find((e) => e.type === 'trade' && e.marketTime === T0 + marketOffset)!.eventId;
    const A = idOf(100);
    const B = idOf(200);
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });

    const fills = r.ledger.ofType('fill');
    expect(fills.map((f) => [f.simTime - T0, f.sourceTradeEventId, f.sourceMarketTime - T0, f.qty])).toEqual([[250, B, 200, '1.000000']]);
    const re = r.ledger.ofType('fill_reattributed');
    expect(re.map((x) => [x.simTime - T0, x.fillId, x.fromTradeEventId, x.toTradeEventId, x.toMarketTime - T0, x.qty, x.outcomesRebased, x.outcomesKept])).toEqual([
      [300, fills[0]!.fillId, B, A, 100, '0.500000', [1000, 3000], []],
    ]);
    // accounting unchanged by the re-attribution: one fill of 1.0, inventory 1.0 from t=250 on
    const decisions = r.ledger.ofType('policy_decision');
    expect(decisions.find((d) => d.simTime === T0 + 300)!.input.inventory).toBe('1.000000');
    expect(r.summary.fills).toMatchObject({ count: 1, qty: '1.000000', reattributed: 1 });
    const p = r.summary.portfolio;
    expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));

    // outcomes: the A portion runs from venue 100 (mid 99.905 at 1100: the empty 99.90 level leaves 99.89/99.92),
    // the remaining B portion from venue 200 (mid 100.905 at 1200)
    const outcomes = r.ledger.ofType('outcome').filter((o) => o.horizonMs === 1000);
    expect(outcomes.map((o) => [o.fillId, o.sourceTradeEventId, o.sourceMarketTime - T0, o.availableAt - T0, o.qty, o.midAtHorizon, o.markout, o.status])).toEqual([
      [fills[0]!.fillId, A, 100, 1100, '0.500000', '99.905000', '0.002500', 'measured'],
      [fills[0]!.fillId, B, 200, 1200, '0.500000', '100.905000', '0.502500', 'measured'],
    ]);
    expect(r.summary.outcomes[0]).toMatchObject({ horizonMs: 1000, count: 2, sumMarkout: '0.505000' });
    // no quantity is ever credited beyond its source print's size
    expect(parseMoney(outcomes[0]!.qty) <= parseMoney('0.5')).toBe(true);
  });

  it('F4 gate: an outcome horizon shorter than the staleness window is refused at configuration', async () => {
    const fx = makeFixture(flatBooks(0, 3000, '99.90', '99.92'), { durationMs: 3000 });
    const cfg = testConfig({ steering: 'disabled', maxStalenessMs: 500, outcomeHorizonsMs: [100, 3000] });
    await expect(replay({ fixture: fx, policy: fixedQuotePolicy({}), controller: null, config: cfg })).rejects.toThrow(
      /outcomeHorizonsMs must each be >= maxStalenessMs \(500 ms\).*got 100 ms/,
    );
  });

  it('F4 boundary: with the horizon equal to the staleness window, the latest possible re-attribution still precedes measurement', async () => {
    // B: through, venue 200, observed 250 -> books 1.0 from B. A: through, venue 100, observed at the maximum lag (600).
    // Horizon 500: B's outcome would be measured at 700, after the re-attribution at 600, so nothing is kept on the old source.
    const fx = makeFixture(
      [
        ...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '0' }),
        trade(200, '99.85', '1.0', 'sell', { lag: 50 }), // B
        trade(100, '99.85', '0.5', 'sell', { lag: 500 }), // A, lag == maxStalenessMs (accepted)
      ],
      { durationMs: 3000 },
    );
    const cfg = testConfig({ steering: 'disabled', maxStalenessMs: 500, outcomeHorizonsMs: [500] });
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: cfg });
    const re = r.ledger.ofType('fill_reattributed');
    expect(re.map((x) => [x.simTime - T0, x.qty, x.outcomesRebased, x.outcomesKept])).toEqual([[600, '0.500000', [500], []]]);
    const outcomes = r.ledger.ofType('outcome');
    expect(outcomes.map((o) => [o.sourceMarketTime - T0, o.availableAt - T0, o.qty, o.status])).toEqual([
      [100, 600, '0.500000', 'measured'],
      [200, 700, '0.500000', 'measured'],
    ]);
    expect(outcomes.every((o) => o.availableAt >= re[0]!.simTime)).toBe(true);
    expect(r.ledger.all().filter((e) => e.type === 'outcome' && e.status === 'superseded_by_reattribution')).toHaveLength(0);
  });
});
