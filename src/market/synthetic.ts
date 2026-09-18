/**
 * Seeded synthetic market generator.
 *
 * Produces L2 book snapshots (every snapshotIntervalMs of market time) and market trades from
 * a piecewise-regime random walk. Everything is derived from the seed; the same parameters
 * always produce a byte-identical fixture.
 *
 * THIS IS NOT A MARKET MODEL. It exists so the engine can be exercised deterministically.
 * See docs/DATA_REQUIREMENTS.md for what real data would be needed.
 */
import { mulberry32 } from '../core/rng.js';
import { PRICE_SCALE, QTY_SCALE, fmtPrice, fmtQty } from '../core/money.js';
import {
  FIXTURE_SCHEMA_VERSION,
  SYNTHETIC_LABEL,
  type BookEvent,
  type Fixture,
  type Level,
  type MarketEvent,
  type TradeEvent,
} from './events.js';

export const GENERATOR_NAME = 'markout-ledger/synthetic';
export const GENERATOR_VERSION = '1.0.0';

export interface Regime {
  /** Regime applies to market steps with (t - startTime) in [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  /** Expected mid drift per step, in ticks. */
  driftTicksPerStep: number;
  /** Std dev of mid change per step, in ticks. */
  volTicksPerStep: number;
  /** Probability that a step prints a trade. */
  tradeProb: number;
  /** Probability a trade's aggressor is a seller (hits bids). */
  sellBias: number;
  /** Probability a trade prints one level through the touch. */
  throughProb: number;
}

export interface SyntheticParams {
  seed: number;
  symbol: string;
  venue: string;
  description: string;
  /** Replay clock origin (ms epoch). */
  startTime: number;
  durationMs: number;
  snapshotIntervalMs: number;
  levels: number;
  tickSize: bigint;
  lotSize: bigint;
  initialMid: bigint;
  regimes: Regime[];
  feedLatency: {
    bookBaseMs: number;
    bookJitterMs: number;
    tradeBaseMs: number;
    tradeJitterMs: number;
  };
}

/** Fixed, obviously synthetic epoch: 2000-01-01T00:00:00Z. */
export const SYNTHETIC_EPOCH_MS = 946_684_800_000;

export function generateSyntheticFixture(p: SyntheticParams): Fixture {
  const rng = mulberry32(p.seed);
  const tick = p.tickSize;
  const steps = Math.floor(p.durationMs / p.snapshotIntervalMs);
  let midTicks = Number(p.initialMid / tick);

  type Raw = { ev: Omit<MarketEvent, 'eventId' | 'seq'>; order: number; kindOrder: number };
  const raw: Raw[] = [];
  let order = 0;

  const regimeAt = (offsetMs: number): Regime => {
    const r = p.regimes.find((x) => offsetMs >= x.fromMs && offsetMs < x.toMs);
    if (!r) throw new Error(`no regime covers offset ${offsetMs}ms`);
    return r;
  };

  for (let i = 0; i < steps; i++) {
    const offset = i * p.snapshotIntervalMs;
    const marketTime = p.startTime + offset;
    const regime = regimeAt(offset);

    midTicks += regime.driftTicksPerStep + regime.volTicksPerStep * rng.gauss();
    if (midTicks < 10) midTicks = 10;

    const spreadTicks = BigInt(2 + rng.int(0, 2));
    const centre = BigInt(Math.round(midTicks));
    const bestBidPx = (centre - spreadTicks / 2n) * tick;
    const bestAskPx = bestBidPx + spreadTicks * tick;

    const bids: Level[] = [];
    const asks: Level[] = [];
    for (let l = 0; l < p.levels; l++) {
      bids.push({ price: bestBidPx - BigInt(l) * tick, size: p.lotSize * BigInt(rng.int(300, 4000)) });
      asks.push({ price: bestAskPx + BigInt(l) * tick, size: p.lotSize * BigInt(rng.int(300, 4000)) });
    }

    const book: Omit<BookEvent, 'eventId' | 'seq'> = {
      type: 'book',
      obsTime: marketTime + p.feedLatency.bookBaseMs + rng.int(0, p.feedLatency.bookJitterMs),
      marketTime,
      symbol: p.symbol,
      venue: p.venue,
      bids,
      asks,
    };
    raw.push({ ev: book, order: order++, kindOrder: 0 });

    if (rng.chance(regime.tradeProb)) {
      const sell = rng.chance(regime.sellBias);
      const through = rng.chance(regime.throughProb);
      const price = sell ? bestBidPx - (through ? tick : 0n) : bestAskPx + (through ? tick : 0n);
      const size = p.lotSize * BigInt(rng.int(100, 2500));
      const tradeMarketTime = marketTime + rng.int(1, p.snapshotIntervalMs - 1);
      const trade: Omit<TradeEvent, 'eventId' | 'seq'> = {
        type: 'trade',
        obsTime: tradeMarketTime + p.feedLatency.tradeBaseMs + rng.int(0, p.feedLatency.tradeJitterMs),
        marketTime: tradeMarketTime,
        symbol: p.symbol,
        venue: p.venue,
        tradeId: `t${i}`,
        price,
        size,
        aggressor: sell ? 'sell' : 'buy',
      };
      raw.push({ ev: trade, order: order++, kindOrder: 1 });
      // Small impact in the direction of the aggressor.
      midTicks += sell ? -0.4 : 0.4;
    }
  }

  raw.sort((a, b) => {
    if (a.ev.obsTime !== b.ev.obsTime) return a.ev.obsTime - b.ev.obsTime;
    if (a.ev.marketTime !== b.ev.marketTime) return a.ev.marketTime - b.ev.marketTime;
    if (a.kindOrder !== b.kindOrder) return a.kindOrder - b.kindOrder;
    return a.order - b.order;
  });

  const events: MarketEvent[] = raw.map((r, seq) => ({
    ...(r.ev as MarketEvent),
    eventId: `ev-${String(seq).padStart(6, '0')}`,
    seq,
  }));

  return {
    header: {
      type: 'header',
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      symbol: p.symbol,
      venue: p.venue,
      priceScale: Number(PRICE_SCALE),
      qtyScale: Number(QTY_SCALE),
      tickSize: fmtPrice(p.tickSize),
      lotSize: fmtQty(p.lotSize),
      startTime: p.startTime,
      endTime: p.startTime + p.durationMs,
      eventCount: events.length,
      synthetic: true,
      syntheticLabel: SYNTHETIC_LABEL,
      provenance: {
        source: 'synthetic',
        description: p.description,
        generator: GENERATOR_NAME,
        generatorVersion: GENERATOR_VERSION,
        seed: p.seed,
        timeBasis: {
          obsTime: 'simulated local receive clock = marketTime + modeled feed latency (ms epoch, synthetic epoch 2000-01-01)',
          marketTime: 'simulated venue clock (ms epoch, synthetic epoch 2000-01-01)',
        },
      },
    },
    events,
  };
}

const WINDOW = 3000;

/** Baseline: calm -> adverse down-drift (sellers hit bids) -> calm -> up-drift -> calm. 13 windows. */
export function baselineParams(): SyntheticParams {
  return {
    seed: 42,
    symbol: 'SYN-USD',
    venue: 'synthetic-clob',
    description:
      'Baseline synthetic fixture: 13 windows of 3s. Calm, then a sell-pressure regime (adverse for resting bids), calm, buy-pressure, calm.',
    startTime: SYNTHETIC_EPOCH_MS,
    durationMs: 13 * WINDOW,
    snapshotIntervalMs: 100,
    levels: 5,
    tickSize: 10_000n, // 0.01
    lotSize: 1_000n, // 0.001
    initialMid: 100n * PRICE_SCALE,
    regimes: [
      { fromMs: 0, toMs: 3 * WINDOW, driftTicksPerStep: 0, volTicksPerStep: 1.2, tradeProb: 0.35, sellBias: 0.5, throughProb: 0.15 },
      { fromMs: 3 * WINDOW, toMs: 6 * WINDOW, driftTicksPerStep: -0.7, volTicksPerStep: 1.6, tradeProb: 0.55, sellBias: 0.8, throughProb: 0.3 },
      { fromMs: 6 * WINDOW, toMs: 9 * WINDOW, driftTicksPerStep: 0, volTicksPerStep: 1.0, tradeProb: 0.3, sellBias: 0.5, throughProb: 0.1 },
      { fromMs: 9 * WINDOW, toMs: 11 * WINDOW, driftTicksPerStep: 0.6, volTicksPerStep: 1.5, tradeProb: 0.5, sellBias: 0.25, throughProb: 0.3 },
      { fromMs: 11 * WINDOW, toMs: 13 * WINDOW, driftTicksPerStep: 0, volTicksPerStep: 1.0, tradeProb: 0.3, sellBias: 0.5, throughProb: 0.1 },
    ],
    feedLatency: { bookBaseMs: 15, bookJitterMs: 30, tradeBaseMs: 10, tradeJitterMs: 25 },
  };
}

/** Risk-gate fixture: persistent one-way sell pressure so a passive quoter accumulates inventory and losses. */
export function riskGateParams(): SyntheticParams {
  return {
    seed: 7,
    symbol: 'SYN-USD',
    venue: 'synthetic-clob',
    description:
      'Risk-gate synthetic fixture: 12 windows of 3s of persistent sell pressure and downward drift. Designed so position and loss limits are hit.',
    startTime: SYNTHETIC_EPOCH_MS,
    durationMs: 12 * WINDOW,
    snapshotIntervalMs: 100,
    levels: 5,
    tickSize: 10_000n,
    lotSize: 1_000n,
    initialMid: 100n * PRICE_SCALE,
    regimes: [
      { fromMs: 0, toMs: 1 * WINDOW, driftTicksPerStep: 0, volTicksPerStep: 1.0, tradeProb: 0.35, sellBias: 0.5, throughProb: 0.15 },
      { fromMs: 1 * WINDOW, toMs: 12 * WINDOW, driftTicksPerStep: -1.2, volTicksPerStep: 1.8, tradeProb: 0.7, sellBias: 0.9, throughProb: 0.4 },
    ],
    feedLatency: { bookBaseMs: 15, bookJitterMs: 30, tradeBaseMs: 10, tradeJitterMs: 25 },
  };
}

export const FIXTURE_CATALOG: Record<string, { file: string; params: () => SyntheticParams }> = {
  baseline: { file: 'fixtures/synthetic-baseline.jsonl', params: baselineParams },
  riskgate: { file: 'fixtures/synthetic-riskgate.jsonl', params: riskGateParams },
};
