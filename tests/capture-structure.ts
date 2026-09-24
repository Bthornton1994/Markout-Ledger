// Reference check of the structural capture rules (docs/M2_DATA_CONTRACT.md sections 5.3, 5.6, 5.8, 5.9 R5, R9 and R10,
// and 8.1): socket spans and settlements, the subscription gate with subscription identity and instrument consistency,
// the segment windows these rules leave, the items a segment may never carry, and the clock samples a segment owns.
//
// It is an executable specification for pull request PR-1, not a normalizer: it reconstructs no book, verifies no
// checksum and emits no event. It reads raw capture records (schemas/capture-record.v1.schema.json) that are already
// parsed, in stream order across files. The normalizer of PR-1 must reach the same verdicts on every vector of
// tests/capture-structure.test.ts (handoff A7(r)); where the two disagree, the contract decides and both are corrected.

export interface RawRecord {
  type: string;
  recvWallMs: number;
  recvMonoNs: string;
  [key: string]: unknown;
}

/** The instrument selected for the capture, as cross-checked at capture start (contract section 8.4). */
export interface SelectedInstrument {
  symbol: string;
  pricePrecision: number;
  qtyPrecision: number;
  /** Decimal lexemes as the venue sends them; compared by value, never through a float. */
  priceIncrement: string;
  qtyIncrement: string;
}

export interface SocketReport {
  /** Stream index of the socket's ws_open. */
  open: number;
  /** Stream index of the first record of its settlement, and of the last (the terminal record). */
  settlement: number;
  terminal: number;
  /** The detail of the settlement's first record. */
  detail: string;
  /** Stream index at which the subscription gate passed (section 5.3), or null. */
  gate: number | null;
  /** Why R9 refuses the socket, or null when it qualifies. */
  refused: string | null;
  /** The only stream indices a segment of this socket may cover (inclusive), or null when the socket yields none. */
  window: [number, number] | null;
}

export interface CaptureReport {
  /** A capture-level refusal (R5 or R10) with the stream index that revealed it, or null. */
  refused: { rule: 'R5' | 'R10'; at: number; reason: string } | null;
  sockets: SocketReport[];
  /** Trade items whose symbol is not the selected instrument's: never emitted (dropped.foreignSymbol, R4). */
  foreignTradeItems: { at: number; item: number }[];
  /** Book messages whose symbol is not the selected instrument's: each cuts the segment (R6, malformed_depth). */
  foreignBookRecords: number[];
  /** True when at least one socket qualifies and no capture-level rule refused the capture. */
  fixtureEligible: boolean;
}

/** The ws_close that must follow each first record of a two-record settlement, directly (section 8.1). */
const PAIRED: Record<string, string> = {
  'ws_error:network_error': 'network_error',
  'ws_error:subscribe_rejected': 'subscribe_rejected',
  'ws_error:resync_budget_exhausted': 'budget_exhausted',
};
/** Single-record settlements of an open socket: ws_close details (remote_close and connection_lost take a code). */
const OPEN_CLOSE = new Set([
  'resync_failed', 'snapshot_timeout', 'subscribe_ack_timeout', 'instrument_snapshot_timeout', 'liveness_timeout',
  'capture_end', 'operator_stop',
]);
const CODED_CLOSE = /^(remote_close|connection_lost):[1-4][0-9]{3}$/;
/** R9: a socket settled by one of these never qualifies, whatever frames precede the settlement (section 8.1). */
const GATE_TIMEOUTS = new Set(['subscribe_ack_timeout', 'snapshot_timeout', 'instrument_snapshot_timeout']);
/** Settlements after which the capture ends: only file_end and manifest_end may follow. */
const ENDS = new Set(['capture_end', 'operator_stop', 'subscribe_rejected', 'resync_budget_exhausted', 'reconnect_budget_exhausted']);
const REQUESTS = new Set(['subscribe', 'unsubscribe', 'ping']);
/** Records that belong to no socket and may appear anywhere before the capture ends. */
const FREE = new Set(['probe', 'note', 'file_start', 'file_end']);

/** A JSON number lexeme as a canonical plain decimal ("1e-08" and "0.000000010" both give "0.00000001"). */
export function canonicalDecimal(lexeme: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme.trim());
  if (!m) throw new Error(`not a decimal lexeme: ${lexeme}`);
  const [, sign, int = '', frac = '', exp = '0'] = m;
  let digits = int + frac;
  let point = int.length + Number(exp);
  if (point <= 0) {
    digits = '0'.repeat(1 - point) + digits;
    point = 1;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(point).replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return body === '0' ? '0' : `${sign}${body}`;
}

/** Parses a payload, keeping the source lexeme of the two increment fields so they compare by value. */
function parsePayload(text: unknown): Record<string, any> | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const keep = new Set(['price_increment', 'qty_increment']);
    const reviver = (key: string, value: unknown, context?: { source?: string }): unknown =>
      keep.has(key) && typeof value === 'number' && context?.source !== undefined ? context.source : value;
    const v = JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const sameDecimal = (a: unknown, b: string): boolean => {
  try {
    return canonicalDecimal(String(a)) === canonicalDecimal(b);
  } catch {
    return false;
  }
};

/** The exact requests of section 8.1 for the selected symbol, by kind, up to their req_id. */
function requestKind(request: Record<string, any>, symbol: string): string | undefined {
  const { req_id: _reqId, ...rest } = request;
  const templates: Record<string, unknown> = {
    'subscribe:book': { method: 'subscribe', params: { channel: 'book', symbol: [symbol], depth: 100, snapshot: true } },
    'subscribe:trade': { method: 'subscribe', params: { channel: 'trade', symbol: [symbol], snapshot: false } },
    'subscribe:instrument': { method: 'subscribe', params: { channel: 'instrument', snapshot: true } },
    'unsubscribe:book': { method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: 100 } },
    ping: { method: 'ping' },
  };
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  return Object.keys(templates).find((k) => canon(templates[k]) === canon(rest));
}

interface OpenSocket {
  open: number;
  requests: Map<number, { kind: string; at: number }>;
  initial: Map<string, number>; // the socket's first subscribe of each channel -> its req_id
  acked: Map<string, number>; // channel -> stream index of the identity-matching success ack of its initial subscribe
  instrumentAt: number | null;
  instrumentSeen: boolean;
  refused: string | null;
}

export function analyzeCapture(records: RawRecord[], instrument: SelectedInstrument): CaptureReport {
  const S = instrument.symbol;
  const report: CaptureReport = { refused: null, sockets: [], foreignTradeItems: [], foreignBookRecords: [], fixtureEligible: false };
  const refuse = (rule: 'R5' | 'R10', at: number, reason: string): CaptureReport => {
    report.refused = { rule, at, reason };
    report.fixtureEligible = false;
    for (const s of report.sockets) s.window = null;
    return report;
  };
  let sock: OpenSocket | null = null;
  let pending: { first: number; expect: string; detail: string } | null = null;
  let ended = false;
  let lastReqId = -Infinity;

  const settle = (first: number, terminal: number, detail: string): void => {
    const s = sock!;
    let refused = s.refused;
    if (refused === null && GATE_TIMEOUTS.has(detail)) refused = `settled by ${detail}`;
    const gateParts = ['book', 'trade', 'instrument'].map((c) => s.acked.get(c));
    const gate = refused === null && gateParts.every((x) => x !== undefined) && s.instrumentAt !== null ? Math.max(...(gateParts as number[]), s.instrumentAt) : null;
    if (refused === null && gate === null) refused = 'the subscription gate never passed: an acknowledgement or the instrument snapshot is missing';
    report.sockets.push({ open: s.open, settlement: first, terminal, detail, gate: refused === null ? gate : null, refused, window: refused === null && gate! + 1 <= first - 1 ? [gate! + 1, first - 1] : null });
    sock = null;
  };

  for (const [i, r] of records.entries()) {
    if (pending) {
      if (!(r.type === 'ws_close' && r.detail === pending.expect)) return refuse('R10', i, `the settlement that began at record ${pending.first} is not followed directly by ws_close ${pending.expect}`);
      settle(pending.first, i, pending.detail);
      if (ENDS.has(pending.detail)) ended = true;
      pending = null;
      continue;
    }
    if (i === 0) {
      if (r.type !== 'manifest_start') return refuse('R10', i, 'the stream does not begin with manifest_start');
      continue;
    }
    if (r.type === 'manifest_end') {
      if (sock) return refuse('R10', i, 'the last socket has no terminal record');
      if (i !== records.length - 1) return refuse('R10', i, 'records follow manifest_end');
      break;
    }
    if (ended) {
      if (r.type !== 'file_end') return refuse('R10', i, `a ${r.type} record after the capture ended`);
      continue;
    }
    if (FREE.has(r.type)) continue;
    if (REQUESTS.has(r.type)) {
      if (!sock) return refuse('R10', i, `a ${r.type} record outside an open socket`);
      const req = parsePayload(r.request);
      const reqId = req?.req_id;
      if (!Number.isSafeInteger(reqId) || (reqId as number) <= lastReqId) return refuse('R10', i, 'a request whose req_id does not exceed every earlier req_id of the capture');
      lastReqId = reqId as number;
      const kind = req ? requestKind(req, S) : undefined;
      if (kind === undefined || kind.split(':')[0] !== (r.type === 'ping' ? 'ping' : r.type)) {
        sock.refused ??= `a ${r.type} request that is not the section 8.1 request for ${S}`;
        continue;
      }
      sock.requests.set(reqId as number, { kind, at: i });
      const channel = kind.split(':')[1];
      if (kind.startsWith('subscribe:') && channel && !sock.initial.has(channel)) sock.initial.set(channel, reqId as number);
      continue;
    }
    if (r.type === 'message') {
      if (!sock) return refuse('R10', i, 'a message record outside an open socket');
      // Frames are dispatched on their own content (section 8.2: channel first, then method), never on the record's
      // stream label.
      const p = parsePayload(r.payload);
      if (!p) continue;
      if (p.channel === undefined && (p.method === 'subscribe' || p.method === 'unsubscribe')) {
        const req = sock.requests.get(p.req_id);
        if (!req) continue;
        const [method, channel = ''] = req.kind.split(':');
        const result = (typeof p.result === 'object' && p.result !== null ? p.result : {}) as Record<string, unknown>;
        const mismatch =
          p.method !== method ||
          (result.channel !== undefined && result.channel !== channel) ||
          (channel !== 'instrument' && result.symbol !== undefined && result.symbol !== S) ||
          (channel === 'book' && result.depth !== undefined && result.depth !== 100);
        if (mismatch) sock.refused ??= `an acknowledgement of req_id ${p.req_id} names another subscription than its request`;
        else if (p.success === true && req.kind.startsWith('subscribe:') && sock.initial.get(channel) === p.req_id) sock.acked.set(channel, i);
        continue;
      }
      if (p.channel === 'instrument') {
        const pair = Array.isArray(p.data?.pairs) ? p.data.pairs.find((x: any) => x?.symbol === S) : undefined;
        if (pair) {
          const spec =
            pair.price_precision === instrument.pricePrecision && pair.qty_precision === instrument.qtyPrecision &&
            sameDecimal(pair.price_increment, instrument.priceIncrement) && sameDecimal(pair.qty_increment, instrument.qtyIncrement);
          if (!spec) return refuse('R5', i, `an instrument ${String(p.type)} gives ${S} another precision or increment than the capture-start specification`);
        }
        if (p.type === 'snapshot') {
          if (sock.instrumentAt !== null || sock.instrumentSeen) {
            // A socket's instrument subscription yields one snapshot; a later one must still carry the pair.
            if (!pair) return refuse('R5', i, `a later instrument snapshot has no entry for ${S}`);
            continue;
          }
          sock.instrumentSeen = true;
          // The capture's first socket fixes the capture-start specification: a missing pair or a status other than
          // online there refuses the capture (R5); on a reconnection it refuses that socket (R9).
          const first = report.sockets.length === 0;
          const problem = !pair ? `the instrument snapshot has no entry for ${S}` : pair.status !== 'online' ? `the instrument snapshot gives ${S} status ${String(pair.status)}` : null;
          if (problem !== null && first) return refuse('R5', i, `${problem}, on the capture's first socket`);
          if (problem !== null) sock.refused ??= problem;
          else sock.instrumentAt = i;
        }
        continue;
      }
      if ((p.channel === 'trade' || p.channel === 'book') && Array.isArray(p.data)) {
        if (p.channel === 'trade') p.data.forEach((item: any, k: number) => item?.symbol !== S && report.foreignTradeItems.push({ at: i, item: k }));
        else if (p.data.some((item: any) => item?.symbol !== S)) report.foreignBookRecords.push(i);
      }
      continue;
    }
    if (r.type === 'ws_open') {
      if (sock) return refuse('R10', i, 'a ws_open while the previous socket has no terminal record');
      sock = { open: i, requests: new Map(), initial: new Map(), acked: new Map(), instrumentAt: null, instrumentSeen: false, refused: null };
      continue;
    }
    if (r.type === 'ws_error' || r.type === 'ws_close') {
      const detail = String(r.detail);
      if (!sock) {
        // No socket is open: only a failed attempt, the end while connecting, or an exhausted reconnection budget.
        if (r.type === 'ws_error' && (detail === 'connect_failed' || detail === 'connect_timeout')) continue;
        if (r.type === 'ws_error' && ENDS.has(detail) && detail !== 'subscribe_rejected' && detail !== 'resync_budget_exhausted') {
          ended = true;
          continue;
        }
        return refuse('R10', i, `a ${r.type} ${detail} while no socket is open`);
      }
      const paired = PAIRED[`${r.type}:${detail}`];
      if (paired) {
        pending = { first: i, expect: paired, detail };
        continue;
      }
      if (r.type === 'ws_close' && (OPEN_CLOSE.has(detail) || CODED_CLOSE.test(detail))) {
        settle(i, i, detail);
        if (ENDS.has(detail)) ended = true;
        continue;
      }
      return refuse('R10', i, `a ${r.type} ${detail} that no row of the lifecycle table writes on an open socket`);
    }
    if (r.type === 'manifest_start') return refuse('R10', i, 'a second manifest_start');
    return refuse('R10', i, `an unexpected ${r.type} record`);
  }
  if (pending) return refuse('R10', records.length - 1, 'the stream ends inside a two-record settlement');
  if (sock) return refuse('R10', records.length - 1, 'the last socket has no terminal record');
  report.fixtureEligible = report.sockets.some((s) => s.window !== null);
  return report;
}

/** The wall-clock step threshold of section 5.6, in milliseconds. */
const STEP_MS = 10;

/**
 * The stream indices at which the wall clock steps against the monotonic clock (section 5.6, R3): for consecutive
 * records, recvWallMs decreases, or the two clocks' increments differ by more than 10 ms. Each is a clock cut.
 */
export function clockSteps(records: RawRecord[]): number[] {
  const steps: number[] = [];
  for (let i = 1; i < records.length; i++) {
    const dWall = records[i]!.recvWallMs - records[i - 1]!.recvWallMs;
    const dMonoMs = Number(BigInt(records[i]!.recvMonoNs) - BigInt(records[i - 1]!.recvMonoNs)) / 1e6;
    if (dWall < 0 || Math.abs(dWall - dMonoMs) > STEP_MS) steps.push(i);
  }
  return steps;
}

export interface OwnedSamples {
  /** Stream index of the first record of the segment's clock epoch: the later of 0 and the last clock step at or before its start. */
  epoch: number;
  /** Stream indices of the millisecond samples (method responses with time_in and time_out) the segment owns. */
  ws: number[];
  /** Stream indices of the REST probes the segment owns. */
  rest: number[];
  source: 'ws_method_response' | 'rest_time' | 'none';
}

/** The REST probe window: probes received at most this long before the segment's first record, by the monotonic clock. */
export const PROBE_LOOKBACK_NS = 900_000_000_000n;

/**
 * The clock samples a segment owns (section 5.6). Its clock epoch starts at the last clock step at or before its first
 * record (record 0 when there is none); a segment never contains a later step, since a step cuts it (R3). It owns:
 * the method responses carrying time_in and time_out whose request record and response record both lie on the
 * segment's own socket, at or after the later of that socket's ws_open and the epoch start, and at or before the
 * segment's end record (so the three acknowledgements of the socket's subscriptions, which always precede its gate,
 * count for every segment of that socket in the same epoch); and the REST probes whose record lies in the epoch at or
 * before the end record, whose send clock, after a step, is not before the step's record, and which were received no
 * more than 15 minutes before the segment's first record. Three or more millisecond samples give source
 * ws_method_response; otherwise one or more probes give rest_time; otherwise none (R2b refuses the segment).
 */
export function ownedClockSamples(records: RawRecord[], socket: SocketReport, start: number, end: number): OwnedSamples {
  if (!socket.window || start < socket.window[0] || end > socket.window[1] || start > end) {
    throw new Error('a segment must lie inside its socket window');
  }
  const steps = clockSteps(records);
  if (steps.some((k) => k > start && k <= end)) throw new Error('a segment never spans a clock step (R3 cuts it)');
  const epoch = steps.filter((k) => k <= start).pop() ?? 0;
  const epochMono = BigInt(records[epoch]!.recvMonoNs);
  const requests = new Set<number>();
  const ws: number[] = [];
  for (let i = Math.max(socket.open, epoch); i <= end; i++) {
    const r = records[i]!;
    if (REQUESTS.has(r.type)) {
      const req = parsePayload(r.request);
      if (Number.isSafeInteger(req?.req_id)) requests.add(req!.req_id);
    } else if (r.type === 'message') {
      const p = parsePayload(r.payload);
      if (p && p.channel === undefined && typeof p.method === 'string' && requests.has(p.req_id) && typeof p.time_in === 'string' && typeof p.time_out === 'string') ws.push(i);
    }
  }
  const from = BigInt(records[start]!.recvMonoNs) - PROBE_LOOKBACK_NS;
  const rest = records.flatMap((r, i) =>
    r.type === 'probe' && i >= epoch && i <= end && BigInt(r.recvMonoNs) >= from && (epoch === 0 || (typeof r.sentMonoNs === 'string' && BigInt(r.sentMonoNs) >= epochMono)) ? [i] : [],
  );
  const source = ws.length >= 3 ? 'ws_method_response' : rest.length >= 1 ? 'rest_time' : 'none';
  return { epoch, ws, rest, source };
}
