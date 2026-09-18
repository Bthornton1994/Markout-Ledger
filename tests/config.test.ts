import { describe, expect, it } from 'vitest';
import { replay, validateReplayConfig, validateReplayConfigAgainstFixture, windowsCovered, type ReplayConfig } from '../src/index.js';
import { fixedQuotePolicy, flatBooks, makeFixture, testConfig } from './helpers.js';

const SHORT_HORIZON = /outcomeHorizonsMs must each be >= maxStalenessMs \(500 ms\).*got 100 ms/;

describe('validateReplayConfig: outcome horizons against the staleness limit', () => {
  it('rejects a 100 ms horizon under a 500 ms staleness limit, naming both values', () => {
    const cfg = testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [100] });
    expect(() => validateReplayConfig(cfg)).toThrow(RangeError);
    expect(() => validateReplayConfig(cfg)).toThrow(SHORT_HORIZON);
  });

  it('rejects the short horizon wherever it sits among accepted ones', () => {
    expect(() => validateReplayConfig(testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [100, 1000, 3000] }))).toThrow(SHORT_HORIZON);
    expect(() => validateReplayConfig(testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [1000, 3000, 100] }))).toThrow(SHORT_HORIZON);
    expect(() => validateReplayConfig(testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [499] }))).toThrow(/got 499 ms/);
  });

  it('accepts the boundary: a horizon equal to the staleness limit', () => {
    expect(() => validateReplayConfig(testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [500] }))).not.toThrow();
    expect(() => validateReplayConfig(testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [500, 3000] }))).not.toThrow();
  });

  it('accepts the shipped configuration and any positive horizon under a zero staleness limit', () => {
    expect(() => validateReplayConfig(testConfig())).not.toThrow(); // 500 ms limit, horizons 1000 and 3000
    expect(() => validateReplayConfig(testConfig({ maxStalenessMs: 0, outcomeHorizonsMs: [1] }))).not.toThrow();
    expect(() => validateReplayConfig(testConfig({ outcomeHorizonsMs: [] }))).not.toThrow();
  });

  it('validates the staleness limit itself before comparing horizons against it', () => {
    // 250.5 is the case that pins the ordering: compared first, 100 < 250.5 would report the horizon instead.
    for (const bad of [-1, 250.5, Number.NaN]) {
      const cfg = testConfig({ maxStalenessMs: bad, outcomeHorizonsMs: [100] });
      expect(() => validateReplayConfig(cfg)).toThrow(new RegExp(`maxStalenessMs must be a non-negative integer, got ${bad}`));
      expect(() => validateReplayConfig(cfg)).not.toThrow(/outcomeHorizonsMs must each be/);
    }
  });

  it('rejects non-positive or non-integer horizons, naming the value', () => {
    for (const bad of [0, -5, 1000.5, Number.NaN]) {
      expect(() => validateReplayConfig(testConfig({ outcomeHorizonsMs: [bad] }))).toThrow(new RegExp(`outcome horizons must be positive integers, got ${bad} ms`));
    }
  });

  it('rejects horizons that are not strictly increasing: index 0 is the reported shortest horizon and a repeat would measure twice', () => {
    expect(() => validateReplayConfig(testConfig({ outcomeHorizonsMs: [1000, 1000] }))).toThrow(/strictly increasing, got 1000 ms followed by 1000 ms/);
    expect(() => validateReplayConfig(testConfig({ outcomeHorizonsMs: [3000, 1000] }))).toThrow(/strictly increasing, got 3000 ms followed by 1000 ms/);
  });

  it('every rule names the field and the offending value', () => {
    const cases: Array<[Partial<ReplayConfig>, RegExp]> = [
      [{ policyTickMs: 0 }, /policyTickMs must be a positive integer, got 0/],
      [{ windowMs: 2.5 }, /windowMs must be a positive integer, got 2.5/],
      [{ windowMs: 3100 }, /windowMs must be a multiple of policyTickMs, got 3100 ms and 300 ms/],
      [{ controllerDeadlineMs: -1 }, /controllerDeadlineMs must be a non-negative integer, got -1/],
      [{ controllerDeadlineMs: 3000 }, /controllerDeadlineMs must be shorter than a window \(3000 ms\), got 3000 ms/],
      [{ numWindows: 1.5 }, /numWindows must be an integer >= 1, got 1.5/],
      [{ numWindows: 0 }, /numWindows must be an integer >= 1, got 0/],
      [{ execution: { ...testConfig().execution, cancelLatencyMs: -3 } }, /execution\.cancelLatencyMs must be a non-negative integer millisecond \(zero is allowed\), got -3/],
      [{ outcomeHorizonsMs: 1000 as unknown as number[] }, /outcomeHorizonsMs must be an array of horizons in ms, got 1000/],
    ];
    for (const [overrides, message] of cases) expect(() => validateReplayConfig(testConfig(overrides))).toThrow(message);
  });
});

describe('validateReplayConfigAgainstFixture: the window count against the fixture', () => {
  const header = { startTime: 0, endTime: 9000 }; // three 3000 ms windows

  it('resolves an omitted count to the fixture coverage and accepts a count up to it', () => {
    expect(windowsCovered(header, 3000)).toBe(3);
    expect(windowsCovered({ startTime: 0, endTime: 8999 }, 3000)).toBe(2);
    expect(validateReplayConfigAgainstFixture(testConfig(), header)).toBe(3);
    expect(validateReplayConfigAgainstFixture(testConfig({ numWindows: 3 }), header)).toBe(3);
    expect(validateReplayConfigAgainstFixture(testConfig({ numWindows: 1 }), header)).toBe(1);
  });

  it('rejects one window more than the fixture covers, and a fixture shorter than a window', () => {
    expect(() => validateReplayConfigAgainstFixture(testConfig({ numWindows: 4 }), header)).toThrow(/fixture covers only 3 windows, 4 requested/);
    expect(() => validateReplayConfigAgainstFixture(testConfig(), { startTime: 0, endTime: 2999 })).toThrow(/fixture covers 0 full windows of 3000 ms; at least one is required/);
  });

  it('applies the configuration rules first', () => {
    expect(() => validateReplayConfigAgainstFixture(testConfig({ maxStalenessMs: 500, outcomeHorizonsMs: [100] }), header)).toThrow(SHORT_HORIZON);
  });
});

describe('a rejected configuration is refused before the replay starts', () => {
  function instrumented() {
    const fx = makeFixture(flatBooks(0, 3000, '99.90', '99.92'), { durationMs: 3000 });
    const events = fx.events;
    const counter = { eventsRead: 0 };
    Object.defineProperty(fx, 'events', {
      get() {
        counter.eventsRead++;
        return events;
      },
    });
    return { fx, counter };
  }

  it('a short horizon writes no ledger entry and reads no fixture event', async () => {
    const { fx, counter } = instrumented();
    const lines: string[] = [];
    const cfg = testConfig({ steering: 'disabled', maxStalenessMs: 500, outcomeHorizonsMs: [100, 3000] });
    await expect(replay({ fixture: fx, policy: fixedQuotePolicy({}), controller: null, config: cfg, ledgerSink: (l) => lines.push(l) })).rejects.toThrow(SHORT_HORIZON);
    expect(lines).toEqual([]);
    expect(counter.eventsRead).toBe(0);
  });

  it('a window count beyond the fixture writes no ledger entry and reads no fixture event', async () => {
    const { fx, counter } = instrumented();
    const lines: string[] = [];
    const cfg = testConfig({ steering: 'disabled', numWindows: 2 }); // the fixture covers one 3000 ms window
    await expect(replay({ fixture: fx, policy: fixedQuotePolicy({}), controller: null, config: cfg, ledgerSink: (l) => lines.push(l) })).rejects.toThrow(/fixture covers only 1 windows, 2 requested/);
    expect(lines).toEqual([]);
    expect(counter.eventsRead).toBe(0);
  });

  it('the same fixture and policy replay normally at the accepted boundary', async () => {
    const fx = makeFixture(flatBooks(0, 3000, '99.90', '99.92'), { durationMs: 3000 });
    const cfg = testConfig({ steering: 'disabled', maxStalenessMs: 500, outcomeHorizonsMs: [500, 3000] });
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({}), controller: null, config: cfg });
    expect(r.ledger.all()[0]?.type).toBe('replay_started');
    expect(r.summary.outcomes.map((o) => o.horizonMs)).toEqual([500, 3000]);
  });
});
