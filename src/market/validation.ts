/**
 * Observation stream validation.
 *
 * Structural checks run in file order before replay (ordering, duplicates, malformed).
 * Content checks run at processing time (staleness, crossed book) because they describe
 * the observation itself rather than its position in the stream.
 */
import type { BookEvent, FixtureHeader, MarketEvent, TradeEvent } from './events.js';

export type ObservationRejectReason =
  | 'duplicate_event'
  | 'out_of_order'
  | 'non_increasing_seq'
  | 'invalid_timestamps'
  | 'stale_observation'
  | 'malformed_event'
  | 'crossed_book'
  | 'wrong_symbol'
  | 'outside_replay_range';

export interface Rejection {
  ok: false;
  reason: ObservationRejectReason;
  detail: string;
}
export type Verdict = { ok: true } | Rejection;

function reject(reason: ObservationRejectReason, detail: string): Rejection {
  return { ok: false, reason, detail };
}

export function checkMalformed(ev: MarketEvent, header: FixtureHeader): Verdict {
  if (ev.symbol !== header.symbol) return reject('wrong_symbol', `expected ${header.symbol}, got ${ev.symbol}`);
  if (!Number.isInteger(ev.obsTime) || !Number.isInteger(ev.marketTime)) {
    return reject('malformed_event', 'timestamps must be integer milliseconds');
  }
  if (ev.obsTime < ev.marketTime) {
    return reject('invalid_timestamps', `obsTime ${ev.obsTime} precedes marketTime ${ev.marketTime}`);
  }
  if (ev.type === 'book') return checkBook(ev);
  return checkTrade(ev);
}

function checkBook(ev: BookEvent): Verdict {
  for (const [side, levels, dir] of [
    ['bids', ev.bids, -1n],
    ['asks', ev.asks, 1n],
  ] as const) {
    let prev: bigint | null = null;
    for (const l of levels) {
      if (l.price <= 0n || l.size <= 0n) return reject('malformed_event', `${side} level with non-positive price/size`);
      if (prev !== null && (l.price - prev) * dir <= 0n) {
        return reject('malformed_event', `${side} not sorted best-first`);
      }
      prev = l.price;
    }
  }
  const b = ev.bids[0];
  const a = ev.asks[0];
  if (b && a && b.price >= a.price) return reject('crossed_book', `bid ${b.price} >= ask ${a.price}`);
  return { ok: true };
}

function checkTrade(ev: TradeEvent): Verdict {
  if (ev.price <= 0n || ev.size <= 0n) return reject('malformed_event', 'trade with non-positive price/size');
  if (!['buy', 'sell', 'unknown'].includes(ev.aggressor)) return reject('malformed_event', 'bad aggressor');
  return { ok: true };
}

/** Stateful structural validator: call in file order. */
export class StreamValidator {
  private readonly seen = new Set<string>();
  private lastSeq = -1;
  private lastObsTime = Number.NEGATIVE_INFINITY;

  constructor(private readonly header: FixtureHeader) {}

  checkStructure(ev: MarketEvent): Verdict {
    if (this.seen.has(ev.eventId)) return reject('duplicate_event', `eventId ${ev.eventId} already seen`);
    if (ev.seq <= this.lastSeq) return reject('non_increasing_seq', `seq ${ev.seq} after ${this.lastSeq}`);
    if (ev.obsTime < this.lastObsTime) {
      return reject('out_of_order', `obsTime ${ev.obsTime} arrived after ${this.lastObsTime}`);
    }
    const malformed = checkMalformed(ev, this.header);
    if (!malformed.ok) return malformed;
    this.seen.add(ev.eventId);
    this.lastSeq = ev.seq;
    this.lastObsTime = ev.obsTime;
    return { ok: true };
  }
}

/** Content check at processing time: an observation that lagged its market time too much is stale. */
export function checkStaleness(ev: MarketEvent, maxStalenessMs: number): Verdict {
  const lag = ev.obsTime - ev.marketTime;
  if (lag > maxStalenessMs) {
    return reject('stale_observation', `obsTime - marketTime = ${lag}ms > ${maxStalenessMs}ms`);
  }
  return { ok: true };
}
