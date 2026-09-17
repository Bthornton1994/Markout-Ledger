import { describe, expect, it } from 'vitest';
import { NoTradePolicy, replay, parseFixture, serializeFixture, SYNTHETIC_LABEL } from '../src/index.js';
import { T0, book, fixedQuotePolicy, flatBooks, makeFixture, testConfig, trade } from './helpers.js';

describe('observation stream validation', () => {
  it('rejects duplicate event ids, out-of-order observations and impossible timestamps', async () => {
    const fx = makeFixture(
      [
        book(0, '100.00', '100.02', { id: 'dup' }),
        book(100, '100.00', '100.02', { id: 'dup' }), // duplicate id
        book(300, '100.00', '100.02'),
        book(200, '100.00', '100.02', { id: 'late' }), // obsTime goes backwards
        book(400, '100.00', '100.02', { id: 'neg', lag: -50 }), // obsTime before marketTime
      ],
      { keepOrder: true },
    );
    const r = await replay({ fixture: fx, policy: new NoTradePolicy(), controller: null, config: testConfig({ steering: 'disabled' }) });
    const rejected = r.ledger.ofType('observation_rejected');
    expect(rejected.map((e) => [e.eventId, e.reason])).toEqual([
      ['dup', 'duplicate_event'],
      ['late', 'out_of_order'],
      ['neg', 'invalid_timestamps'],
    ]);
    expect(r.summary.observations.accepted).toBe(2);
    expect(rejected.every((e) => e.phase === 'structural')).toBe(true);
  });

  it('rejects stale observations at processing time and the policy never sees them', async () => {
    const fx = makeFixture([
      book(0, '100.00', '100.02'),
      book(100, '90.00', '90.02', { lag: 900, id: 'stale' }), // arrives at t=1000 but is 900ms old
      book(1100, '100.00', '100.02'),
    ]);
    const policy = fixedQuotePolicy({ bid: '99.00', qty: '1' });
    const r = await replay({ fixture: fx, policy, controller: null, config: testConfig({ steering: 'disabled', maxStalenessMs: 500 }) });
    const rejected = r.ledger.ofType('observation_rejected');
    expect(rejected.map((e) => [e.eventId, e.reason, e.phase])).toEqual([['stale', 'stale_observation', 'content']]);
    expect(rejected[0]!.simTime).toBe(T0 + 1000);
    for (const input of policy.inputs) expect(input.book?.eventId).not.toBe('stale');
  });

  it('rejects crossed books and malformed levels', async () => {
    const fx = makeFixture([book(0, '100.00', '100.02'), book(100, '100.05', '100.02', { id: 'crossed' }), trade(200, '100.00', '0', 'sell', { id: 'zero' })]);
    const r = await replay({ fixture: fx, policy: new NoTradePolicy(), controller: null, config: testConfig({ steering: 'disabled' }) });
    expect(r.ledger.ofType('observation_rejected').map((e) => [e.eventId, e.reason])).toEqual([
      ['crossed', 'crossed_book'],
      ['zero', 'malformed_event'],
    ]);
  });

  it('refuses a synthetic fixture that does not carry the synthetic label', () => {
    const fx = makeFixture(flatBooks(0, 300, '100.00', '100.02'));
    const text = serializeFixture(fx).replace(SYNTHETIC_LABEL, 'totally real data');
    expect(() => parseFixture(text)).toThrow(/SYNTHETIC_LABEL/);
  });

  it('a stale book makes the market-making policy pull quotes rather than quote on old data', async () => {
    const { MarketMakerPolicy, DEFAULT_POLICY } = await import('../src/index.js');
    const fx = makeFixture([...flatBooks(0, 1000, '100.00', '100.02'), book(2900, '100.00', '100.02')], { durationMs: 3000 });
    const policy = new MarketMakerPolicy(DEFAULT_POLICY);
    const r = await replay({ fixture: fx, policy, controller: null, config: testConfig({ steering: 'disabled' }) });
    const decisions = r.ledger.ofType('policy_decision');
    const at = (t: number) => decisions.find((d) => d.simTime === T0 + t)!;
    expect(at(900).decision.intent).toBe('quote');
    expect(at(2400).decision.intent).toBe('pull'); // last book at 1000 -> 1400ms old > 1000ms
    expect(at(2400).decision.reason).toMatch(/stale/);
  });
});
