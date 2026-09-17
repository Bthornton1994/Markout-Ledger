import {
  DEFAULT_BASE,
  DEFAULT_EXECUTION,
  FIXTURE_SCHEMA_VERSION,
  MONEY_SCALE,
  PRICE_SCALE,
  QTY_SCALE,
  SYNTHETIC_LABEL,
  ScriptedPolicy,
  fmtPrice,
  fmtQty,
  parsePrice,
  parseQty,
  type Aggressor,
  type Fixture,
  type MarketEvent,
  type PolicyDecision,
  type PolicyInput,
  type ReplayConfig,
} from '../src/index.js';

export const T0 = 946_684_800_000;
export const TICK = 10_000n;
export const LOT = 1_000n;

export type EvSpec =
  | { kind: 'book'; t: number; bid: string; ask: string; bidSize?: string; askSize?: string; levels?: number; lag?: number; id?: string }
  | { kind: 'trade'; t: number; price: string; size: string; aggressor?: Aggressor; lag?: number; id?: string };

export function book(t: number, bid: string, ask: string, extra: Partial<Extract<EvSpec, { kind: 'book' }>> = {}): EvSpec {
  return { kind: 'book', t, bid, ask, ...extra };
}
export function trade(t: number, price: string, size: string, aggressor: Aggressor = 'unknown', extra: Partial<Extract<EvSpec, { kind: 'trade' }>> = {}): EvSpec {
  return { kind: 'trade', t, price, size, aggressor, ...extra };
}

/** Flat book every `everyMs` from `from` to `to` (inclusive) at the given touch. */
export function flatBooks(from: number, to: number, bid: string, ask: string, everyMs = 100, extra: Partial<Extract<EvSpec, { kind: 'book' }>> = {}): EvSpec[] {
  const out: EvSpec[] = [];
  for (let t = from; t <= to; t += everyMs) out.push(book(t, bid, ask, extra));
  return out;
}

export interface FixtureOpts {
  durationMs?: number;
  symbol?: string;
  /** Keep the given order instead of sorting by obsTime (for ordering-violation tests). */
  keepOrder?: boolean;
}

export function makeFixture(specs: EvSpec[], opts: FixtureOpts = {}): Fixture {
  const symbol = opts.symbol ?? 'TEST-USD';
  const raw = specs.map((s, i) => {
    const marketTime = T0 + s.t;
    const obsTime = marketTime + (s.lag ?? 0);
    if (s.kind === 'book') {
      const levels = s.levels ?? 3;
      const bidPx = parsePrice(s.bid);
      const askPx = parsePrice(s.ask);
      const bids = [];
      const asks = [];
      // A '0' best size means "no displayed liquidity at the touch": the level is omitted (the validator rejects zero sizes).
      for (let l = 0; l < levels; l++) {
        const bs = l === 0 ? parseQty(s.bidSize ?? '2') : parseQty('2');
        const as = l === 0 ? parseQty(s.askSize ?? '2') : parseQty('2');
        if (bs > 0n) bids.push({ price: bidPx - BigInt(l) * TICK, size: bs });
        if (as > 0n) asks.push({ price: askPx + BigInt(l) * TICK, size: as });
      }
      return { i, id: s.id, ev: { type: 'book' as const, obsTime, marketTime, symbol, venue: 'test', bids, asks } };
    }
    return {
      i,
      id: s.id,
      ev: {
        type: 'trade' as const,
        obsTime,
        marketTime,
        symbol,
        venue: 'test',
        tradeId: `t${i}`,
        price: parsePrice(s.price),
        size: parseQty(s.size),
        aggressor: s.aggressor ?? 'unknown',
      },
    };
  });
  if (!opts.keepOrder) raw.sort((a, b) => a.ev.obsTime - b.ev.obsTime || a.i - b.i);
  const events: MarketEvent[] = raw.map((r, seq) => ({ ...r.ev, seq, eventId: r.id ?? `e${seq}` }));
  const maxObs = events.reduce((m, e) => Math.max(m, e.obsTime), T0);
  const durationMs = opts.durationMs ?? Math.max(3000, Math.ceil((maxObs - T0) / 3000) * 3000);
  return {
    header: {
      type: 'header',
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      symbol,
      venue: 'test',
      priceScale: Number(PRICE_SCALE),
      qtyScale: Number(QTY_SCALE),
      tickSize: fmtPrice(TICK),
      lotSize: fmtQty(LOT),
      startTime: T0,
      endTime: T0 + durationMs,
      eventCount: events.length,
      synthetic: true,
      syntheticLabel: SYNTHETIC_LABEL,
      provenance: {
        source: 'synthetic',
        description: 'hand-built test fixture',
        generator: 'tests/helpers.ts',
        generatorVersion: '1',
        timeBasis: { obsTime: 'T0 + t + lag', marketTime: 'T0 + t' },
      },
    },
    events,
  };
}

export function testConfig(overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    runId: 'test',
    label: 'test',
    policyTickMs: 300,
    windowMs: 3000,
    controllerDeadlineMs: 200,
    steering: 'enabled',
    maxStalenessMs: 500,
    outcomeHorizonsMs: [1000, 3000],
    initialCash: 10_000n * MONEY_SCALE,
    execution: { ...DEFAULT_EXECUTION },
    risk: { ...DEFAULT_BASE.risk },
    ...overrides,
  };
}

/** Policy that rests fixed quotes whenever a book is available; optional pull from a given tick. */
export function fixedQuotePolicy(opts: { bid?: string; ask?: string; qty?: string; pullFromTick?: number; holdUntilTick?: number }): ScriptedPolicy {
  const qty = parseQty(opts.qty ?? '1');
  return new ScriptedPolicy((input: PolicyInput): PolicyDecision => {
    if (opts.holdUntilTick !== undefined && input.tick < opts.holdUntilTick) return { intent: 'hold', bid: null, ask: null, reason: 'scripted hold' };
    if (opts.pullFromTick !== undefined && input.tick >= opts.pullFromTick) return { intent: 'pull', bid: null, ask: null, reason: 'scripted pull' };
    if (!input.book) return { intent: 'hold', bid: null, ask: null, reason: 'no book' };
    return {
      intent: 'quote',
      bid: opts.bid ? { price: parsePrice(opts.bid), qty } : null,
      ask: opts.ask ? { price: parsePrice(opts.ask), qty } : null,
      reason: 'scripted fixed quotes',
    };
  });
}

export function stripHashes<T extends { hash: string; prevHash: string }>(e: T): Omit<T, 'hash' | 'prevHash'> {
  const { hash: _h, prevHash: _p, ...rest } = e;
  return rest;
}
