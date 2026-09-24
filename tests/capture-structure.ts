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
  /**
   * A capture-level refusal (R1, R1b, R5 or R10) with the stream index at which the checker found it, or null. R1 here
   * is a missing manifest_start or manifest_end only, compared by rule (handoff A7(r)); the normalize report names R5
   * by rule and field only (its at is null, section 5.10); R1b and R10 name this record.
   */
  refused: { rule: 'R1' | 'R1b' | 'R5' | 'R10'; at: number; reason: string } | null;
  sockets: SocketReport[];
  /**
   * Trade items of another pair in trade update frames on sockets R9 does not refuse: each is dropped.foreignSymbol
   * (R4) and never emitted. (Section 5.5's precedence counts such an item in a snapshot frame as tradeSnapshotHistory,
   * and on an R9 socket as socketNotSubscribed, so those are not listed.)
   */
  foreignTradeItems: { at: number; item: number }[];
  /**
   * Book messages of another pair inside a qualifying socket's window: each is malformed and cuts the segment open at
   * it (R6, malformed_depth), or is no cut when no segment is open there (section 5.8).
   */
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

/** The text of each request of section 8.1 for the selected symbol, with <n> for its req_id, by kind. */
function requestTemplates(symbol: string): [string, string][] {
  const sym = JSON.stringify([symbol]);
  return [
    ['subscribe:book', `{"method":"subscribe","params":{"channel":"book","symbol":${sym},"depth":100,"snapshot":true},"req_id":<n>}`],
    ['subscribe:trade', `{"method":"subscribe","params":{"channel":"trade","symbol":${sym},"snapshot":false},"req_id":<n>}`],
    ['subscribe:instrument', '{"method":"subscribe","params":{"channel":"instrument","snapshot":true},"req_id":<n>}'],
    ['unsubscribe:book', `{"method":"unsubscribe","params":{"channel":"book","symbol":${sym},"depth":100},"req_id":<n>}`],
    ['ping', '{"method":"ping","req_id":<n>}'],
  ];
}

/**
 * The kind and req_id of a request whose text is, byte for byte, its section 8.1 row for the selected symbol with <n>
 * replaced by a decimal req_id (no sign, no leading zero, a safe integer), or undefined for any other text.
 */
function requestKind(text: unknown, symbol: string): { kind: string; reqId: number } | undefined {
  if (typeof text !== 'string') return undefined;
  for (const [kind, template] of requestTemplates(symbol)) {
    const [before, after] = template.split('<n>') as [string, string];
    if (!text.startsWith(before) || !text.endsWith(after)) continue;
    const digits = text.slice(before.length, text.length - after.length);
    if (!/^(0|[1-9][0-9]*)$/.test(digits)) continue;
    const reqId = Number(digits);
    if (Number.isSafeInteger(reqId)) return { kind, reqId };
  }
  return undefined;
}

/** The method that answers a request of each method (section 8.1, Subscription identity). */
const ANSWER: Record<string, string> = { subscribe: 'subscribe', unsubscribe: 'unsubscribe', ping: 'pong' };

interface OpenSocket {
  open: number;
  /** req_id -> the request's kind, and whether a response has answered it. */
  requests: Map<number, { kind: string; answered: boolean }>;
  initial: Map<string, number>; // the socket's first subscribe of each channel -> its req_id
  acked: Map<string, number>; // channel -> stream index of the success acknowledgement of its initial subscribe
  instrumentAt: number | null;
  instrumentSeen: boolean;
  refused: string | null;
}

export function analyzeCapture(records: RawRecord[], instrument: SelectedInstrument): CaptureReport {
  const S = instrument.symbol;
  const report: CaptureReport = { refused: null, sockets: [], foreignTradeItems: [], foreignBookRecords: [], fixtureEligible: false };
  const refuse = (rule: 'R1' | 'R1b' | 'R5' | 'R10', at: number, reason: string): CaptureReport => {
    report.refused = { rule, at, reason };
    report.fixtureEligible = false;
    for (const s of report.sockets) s.window = null;
    report.foreignTradeItems = [];
    report.foreignBookRecords = [];
    return report;
  };
  let sock: OpenSocket | null = null;
  let pending: { first: number; expect: string; detail: string } | null = null;
  let ended = false;
  let lastReqId = -Infinity;
  /** Whether the capture's first instrument snapshot, which fixes the capture-start specification, has arrived. */
  let specSeen = false;
  const tradeCandidates: { at: number; item: number; socket: number }[] = [];
  const bookCandidates: { at: number; socket: number }[] = [];

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

  // The manifest first (R1, section 5.10 step (1)): the stream begins with manifest_start and ends with manifest_end,
  // whatever else it holds. A run whose manifest_start is missing writes no normalize report at all (section 5.10).
  if (records[0]?.type !== 'manifest_start') return refuse('R1', 0, 'the stream does not begin with manifest_start');
  if (records[records.length - 1]!.type !== 'manifest_end') return refuse('R1', records.length - 1, 'the stream does not end with manifest_end');

  for (const [i, r] of records.entries()) {
    if (i === 0) continue;
    // File structure (R1b): a file_end is followed only by the next file's file_start or, in the last file, by
    // manifest_end, and a file_start only follows a file_end, so no record lies outside the bytes a file hash covers.
    // Checked before the lifecycle rules, since section 5.10 orders R1b before R10 at the same record.
    const prev = records[i - 1]!.type;
    if (prev === 'file_end' && r.type !== 'file_start' && r.type !== 'manifest_end') return refuse('R1b', i, `a ${r.type} record after a file_end, outside every file hash`);
    if (r.type === 'file_start' && prev !== 'file_end') return refuse('R1b', i, 'a file_start that does not follow a file_end');
    if (pending) {
      if (!(r.type === 'ws_close' && r.detail === pending.expect)) return refuse('R10', i, `the settlement that began at record ${pending.first} is not followed directly by ws_close ${pending.expect}`);
      settle(pending.first, i, pending.detail);
      if (ENDS.has(pending.detail)) ended = true;
      pending = null;
      continue;
    }
    if (r.type === 'manifest_end') {
      if (sock) return refuse('R10', i, 'the last socket has no terminal record');
      if (prev !== 'file_end') return refuse('R10', i, 'a manifest_end that does not follow the last file_end');
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
      const request = requestKind(r.request, S);
      if (request === undefined || request.kind.split(':')[0] !== r.type) {
        // Not its row's exact text (a missing or malformed req_id included): the socket is refused (R9).
        sock.refused ??= `a ${r.type} request whose text is not its section 8.1 row for ${S}`;
        continue;
      }
      if (request.reqId <= lastReqId) return refuse('R10', i, 'a request whose req_id does not exceed every earlier req_id of the capture');
      lastReqId = request.reqId;
      sock.requests.set(request.reqId, { kind: request.kind, answered: false });
      const channel = request.kind.split(':')[1];
      if (request.kind.startsWith('subscribe:') && channel && !sock.initial.has(channel)) sock.initial.set(channel, request.reqId);
      continue;
    }
    if (r.type === 'message') {
      if (!sock) return refuse('R10', i, 'a message record outside an open socket');
      // Frames are dispatched on their own content (section 8.2: channel first, then method), never on the record's
      // stream label.
      const p = parsePayload(r.payload);
      if (!p) continue;
      if (p.channel === undefined && typeof p.method === 'string') {
        const req = sock.requests.get(p.req_id);
        if (!req) continue; // answers no request of this socket, so counts for nothing
        const [method, channel = ''] = req.kind.split(':') as [string, string?];
        if (req.answered) {
          // A second response to an answered request; whether the venue ever sends one is unknown, so fail closed.
          sock.refused ??= `a second response to req_id ${p.req_id}`;
          continue;
        }
        req.answered = true;
        const result = (typeof p.result === 'object' && p.result !== null ? p.result : {}) as Record<string, unknown>;
        const mismatch =
          p.method !== ANSWER[method] ||
          (result.channel !== undefined && result.channel !== channel) ||
          ((channel === 'book' || channel === 'trade') && result.symbol !== undefined && result.symbol !== S) ||
          (channel === 'book' && result.depth !== undefined && result.depth !== 100) ||
          (method === 'subscribe' && result.snapshot !== undefined && result.snapshot !== (channel !== 'trade'));
        if (mismatch) sock.refused ??= `a response to req_id ${p.req_id} that names another method or subscription than its request`;
        else if (p.success === true && method === 'subscribe' && sock.initial.get(channel) === p.req_id) sock.acked.set(channel, i);
        continue;
      }
      if (p.channel === 'instrument') {
        // A decodable instrument frame whose specification cannot be read refuses the capture (R5, section 8.1): data
        // that is not an object, or pairs, when present, that is not a list of objects each carrying a string symbol.
        const data = p.data;
        const isEntry = (x: any): boolean => typeof x === 'object' && x !== null && !Array.isArray(x) && typeof x.symbol === 'string';
        if (typeof data !== 'object' || data === null || Array.isArray(data) || (data.pairs !== undefined && !(Array.isArray(data.pairs) && data.pairs.every(isEntry)))) {
          return refuse('R5', i, `a malformed instrument ${String(p.type)}: its data is not an object, or its pairs is not a list of entries that each carry a string symbol`);
        }
        const entries = Array.isArray(data.pairs) ? data.pairs.filter((x: any) => x.symbol === S) : [];
        // An instrument frame lists the selected pair at most once: two entries could disagree (R5, section 8.1).
        if (entries.length > 1) return refuse('R5', i, `an instrument ${String(p.type)} lists ${S} more than once`);
        const pair = entries[0];
        if (pair) {
          const spec =
            pair.price_precision === instrument.pricePrecision && pair.qty_precision === instrument.qtyPrecision &&
            sameDecimal(pair.price_increment, instrument.priceIncrement) && sameDecimal(pair.qty_increment, instrument.qtyIncrement);
          if (!spec) return refuse('R5', i, `an instrument ${String(p.type)} gives ${S} another precision or increment than the capture-start specification`);
        }
        if (p.type === 'snapshot') {
          if (sock.instrumentSeen) {
            // A socket's instrument subscription yields one snapshot; a later one must still carry the pair.
            if (!pair) return refuse('R5', i, `a later instrument snapshot has no entry for ${S}`);
            continue;
          }
          sock.instrumentSeen = true;
          // The capture's first instrument snapshot completes the capture-start specification: a missing pair or a
          // status other than online there refuses the capture (R5); any other socket's first snapshot refuses only
          // that socket (R9). A snapshot the tie rule wrote before its socket's instrument_snapshot_timeout still counts
          // as the capture's first (fail closed), although it satisfies none of its socket's waits.
          const problem = !pair ? `the instrument snapshot has no entry for ${S}` : pair.status !== 'online' ? `the instrument snapshot gives ${S} status ${String(pair.status)}` : null;
          if (problem !== null && !specSeen) return refuse('R5', i, `${problem}, in the capture's first instrument snapshot`);
          specSeen = true;
          if (problem !== null) sock.refused ??= problem;
          else sock.instrumentAt = i;
        }
        continue;
      }
      if ((p.channel === 'trade' || p.channel === 'book') && Array.isArray(p.data)) {
        const socket = report.sockets.length;
        if (p.channel === 'trade' && p.type === 'update') p.data.forEach((item: any, k: number) => item?.symbol !== S && tradeCandidates.push({ at: i, item: k, socket }));
        else if (p.channel === 'book' && p.data.some((item: any) => item?.symbol !== S)) bookCandidates.push({ at: i, socket });
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
  if (!specSeen) return refuse('R5', records.length - 1, 'the capture has no instrument snapshot, so the instrument channel gives no specification');
  const qualifying = (k: number): boolean => report.sockets[k]?.refused === null;
  report.foreignTradeItems = tradeCandidates.filter((c) => qualifying(c.socket)).map(({ at, item }) => ({ at, item }));
  report.foreignBookRecords = bookCandidates.filter((c) => { const w = report.sockets[c.socket]?.window; return w != null && c.at >= w[0] && c.at <= w[1]; }).map((c) => c.at);
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

/**
 * An RFC 3339 date-time as integer microseconds since the epoch (fraction digits beyond the microsecond dropped), or
 * undefined for anything else (section 5.6): upper-case T and Z only, a real calendar date in any year 0000-9999
 * (proleptic Gregorian), hour 00-23, minute and
 * second 00-59 (a leap second, :60, is no sample: the venue's leap-second convention is unknown), and an offset of Z or
 * +-HH:MM with HH 00-23 and MM 00-59.
 */
export function rfc3339Micros(text: unknown): bigint | undefined {
  if (typeof text !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (days === undefined || d < 1 || d > days || h > 23 || mi > 59 || se > 59) return undefined;
  let offsetMin = 0;
  if (m[8] !== undefined) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 23 || om > 59) return undefined;
    offsetMin = (m[8] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  // setUTCFullYear, not Date.UTC, which maps the years 0 to 99 to 1900 to 1999.
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, se, 0);
  const ms = t.getTime() - offsetMin * 60_000;
  return BigInt(ms) * 1000n + BigInt((m[7] ?? '').padEnd(6, '0').slice(0, 6));
}

/** The unixtime of a usable REST Time probe (its payload's error array is empty and result.unixtime is an integer). */
function probeUnixtime(r: RawRecord): number | undefined {
  const p = parsePayload(r.payload);
  const t = p?.result?.unixtime;
  return Array.isArray(p?.error) && p.error.length === 0 && Number.isSafeInteger(t) ? t : undefined;
}

export interface OwnedSamples {
  /** Stream index of the first record of the segment's clock epoch: the later of 0 and the last clock step at or before its start. */
  epoch: number;
  /** Stream indices of the usable millisecond samples the segment owns (responses that answer its requests), each with its request's index. */
  ws: number[];
  /** Stream indices of the usable REST probes the segment owns. */
  rest: number[];
  source: 'ws_method_response' | 'rest_time' | 'none';
  /** For each entry of ws, the stream index of the request it answers. */
  wsRequests: number[];
}

/** The REST probe window: probes received at most this long before the segment's first record, by the monotonic clock. */
export const PROBE_LOOKBACK_NS = 900_000_000_000n;

/**
 * The clock samples a segment owns (section 5.6). `start` is the segment's first record as section 5.10 defines it (the
 * record of its first event). Its clock epoch starts at the last clock step at or before `start` (record 0 when there
 * is none); a segment with an event never contains a step after its start, since a step cuts it (R3). It owns: every
 * usable method response (both time_in and time_out RFC 3339 instants) that is the first response to a request of the
 * segment's own socket and has the method that answers it, with the request record and the response record both at or
 * after the later of that socket's ws_open and the epoch start and at or before the segment's end record (so each
 * acknowledgement of the socket's initial subscriptions, which precede its gate, counts for every segment of that
 * socket whose epoch starts at or before its subscribe record); and every usable REST probe (an empty error array and an integer result.unixtime) whose record lies in the
 * epoch at or before the end record, whose send clock, after a step, is not before the step's record, and which was
 * received no more than 15 minutes before `start`. Three or more millisecond samples give source ws_method_response;
 * otherwise one or more probes give rest_time; otherwise none (R2b refuses the segment).
 */
export function ownedClockSamples(records: RawRecord[], socket: SocketReport, start: number, end: number): OwnedSamples {
  if (!socket.window || start < socket.window[0] || end > socket.window[1] || start > end) {
    throw new Error('a segment must lie inside its socket window');
  }
  const steps = clockSteps(records);
  if (steps.some((k) => k > start && k <= end)) throw new Error('a segment never spans a clock step (R3 cuts it)');
  const epoch = steps.filter((k) => k <= start).pop() ?? 0;
  const epochMono = BigInt(records[epoch]!.recvMonoNs);
  const requests = new Map<number, { method: string; at: number; answered: boolean }>();
  const ws: number[] = [];
  const wsRequests: number[] = [];
  for (let i = Math.max(socket.open, epoch); i <= end; i++) {
    const r = records[i]!;
    if (REQUESTS.has(r.type)) {
      const parsed = parsePayload(r.request);
      if (Number.isSafeInteger(parsed?.req_id) && typeof parsed?.method === 'string') requests.set(parsed.req_id, { method: parsed.method, at: i, answered: false });
    } else if (r.type === 'message') {
      const p = parsePayload(r.payload);
      if (!p || p.channel !== undefined || typeof p.method !== 'string') continue;
      const req = requests.get(p.req_id);
      if (!req || req.answered) continue;
      req.answered = true;
      if (p.method === ANSWER[req.method] && rfc3339Micros(p.time_in) !== undefined && rfc3339Micros(p.time_out) !== undefined) {
        ws.push(i);
        wsRequests.push(req.at);
      }
    }
  }
  const from = BigInt(records[start]!.recvMonoNs) - PROBE_LOOKBACK_NS;
  const rest = records.flatMap((r, i) =>
    r.type === 'probe' && i >= epoch && i <= end && BigInt(r.recvMonoNs) >= from && probeUnixtime(r) !== undefined && Number.isSafeInteger(r.sentWallMs) &&
    (epoch === 0 || (typeof r.sentMonoNs === 'string' && BigInt(r.sentMonoNs) >= epochMono)) ? [i] : [],
  );
  const source = ws.length >= 3 ? 'ws_method_response' : rest.length >= 1 ? 'rest_time' : 'none';
  return { epoch, ws, rest, source, wsRequests };
}

export interface ClockEstimate {
  samples: number;
  /** Integer microseconds divided by 1000, written with exactly three decimals (section 5.6). */
  medianMs: string;
  medianRttMs: string;
  maxAbsMs: string;
  resolutionMs: 1 | 1000;
  source: 'ws_method_response' | 'rest_time';
}

const ms3 = (us: bigint): string => {
  const abs = us < 0n ? -us : us;
  return `${us < 0n ? '-' : ''}${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
};
/** The nearest-rank median: the ceil(count / 2)-th smallest value. */
const median = (values: bigint[]): bigint => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.ceil(values.length / 2) - 1]!;

/**
 * The venueClockOffsetMs values of section 5.6 from the samples a segment owns, or null for source none. Every instant
 * is integer microseconds. A millisecond sample: t0 the request record's recvWallMs * 1000, t1 time_in, t2 time_out,
 * t3 the response record's recvWallMs * 1000. A REST sample: t0 the probe's sentWallMs * 1000, t3 its recvWallMs *
 * 1000, and t1 = t2 = unixtime * 1000000 + 500000 (the middle of the whole second the venue reported). Offset
 * ((t1 - t0) + (t2 - t3)) / 2 and round trip (t3 - t0) - (t2 - t1), the division truncating toward zero.
 */
export function clockEstimate(records: RawRecord[], owned: OwnedSamples): ClockEstimate | null {
  if (owned.source === 'none') return null;
  const pairs: [bigint, bigint, bigint, bigint][] =
    owned.source === 'ws_method_response'
      ? owned.ws.map((i, k) => {
          const p = parsePayload(records[i]!.payload)!;
          return [BigInt(records[owned.wsRequests[k]!]!.recvWallMs) * 1000n, rfc3339Micros(p.time_in)!, rfc3339Micros(p.time_out)!, BigInt(records[i]!.recvWallMs) * 1000n];
        })
      : owned.rest.map((i) => {
          const r = records[i]!;
          const venue = BigInt(probeUnixtime(r)!) * 1000000n + 500000n;
          return [BigInt(r.sentWallMs as number) * 1000n, venue, venue, BigInt(r.recvWallMs) * 1000n];
        });
  const offsets = pairs.map(([t0, t1, t2, t3]) => (t1 - t0 + (t2 - t3)) / 2n);
  const rtts = pairs.map(([t0, t1, t2, t3]) => t3 - t0 - (t2 - t1));
  const maxAbs = offsets.reduce((m, o) => (o < 0n ? -o : o) > m ? (o < 0n ? -o : o) : m, 0n);
  return { samples: pairs.length, medianMs: ms3(median(offsets)), medianRttMs: ms3(median(rtts)), maxAbsMs: ms3(maxAbs), resolutionMs: owned.source === 'rest_time' ? 1000 : 1, source: owned.source };
}
