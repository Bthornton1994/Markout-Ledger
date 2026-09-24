// Vectors for the structural capture rules (docs/M2_DATA_CONTRACT.md sections 5.3, 5.6, 5.8, 5.9 and 8.1) checked by
// tests/capture-structure.ts. Every record is built from the constructed examples of schemas/examples and must be valid
// against schemas/capture-record.v1.schema.json, so each vector is a raw stream the runner could write. The values are
// invented for the tests; none is venue data. PR-1's normalizer must reach the same verdicts (handoff A7(r)).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { analyzeCapture, canonicalDecimal, clockEstimate, clockSteps, ownedClockSamples, rfc3339Micros, type RawRecord, type SelectedInstrument } from './capture-structure.js';

const addFormats = addFormatsModule.default;
const repoRoot = new URL('../', import.meta.url);
const readJson = (path: string): any => JSON.parse(readFileSync(new URL(path, repoRoot), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv, ['date', 'date-time', 'uuid']);
const captureRecord = ajv.compile(readJson('schemas/capture-record.v1.schema.json'));
const examples = readJson('schemas/examples/capture-record.v1.examples.json').examples;

const BTC: SelectedInstrument = { symbol: 'BTC/USD', pricePrecision: 1, qtyPrecision: 8, priceIncrement: '0.1', qtyIncrement: '0.00000001' };
type Channel = 'book' | 'trade' | 'instrument';
interface Pair { symbol?: string; status?: string; qtyPrecision?: number; pricePrecision?: number; qtyIncrement?: string; priceIncrement?: string }

/** A raw stream under construction: clocks advance 10 ms per record unless advanced further. */
class Tape {
  readonly records: RawRecord[] = [];
  private ms = 0;
  /** A wall-clock offset against the monotonic clock: a clock step when it changes by more than 10 ms (section 5.6). */
  private wallShift = 0;
  private reqId = 0;
  constructor() {
    this.push('manifest_start', { ...structuredClone(examples.manifest_start) });
  }
  advance(ms: number): this {
    this.ms += ms;
    return this;
  }
  /** Steps the wall clock by `ms` against the monotonic clock; the next record is a clock cut (R3). */
  stepWall(ms: number): this {
    this.wallShift += ms;
    return this;
  }
  push(type: string, extra: Record<string, unknown> = {}): number {
    this.ms += 10;
    const { type: _t, recvWallMs: _w, recvMonoNs: _m, ...rest } = extra;
    this.records.push({ type, recvWallMs: 1791288000000 + this.ms + this.wallShift, recvMonoNs: String(5_000_000_000_000n + BigInt(this.ms) * 1_000_000n), ...rest });
    return this.records.length - 1;
  }
  open(): number {
    return this.push('ws_open', { detail: 'open' });
  }
  close(detail: string): number {
    return this.push('ws_close', { detail });
  }
  error(detail: string): number {
    return this.push('ws_error', { detail });
  }
  /** A request record; returns its req_id. `symbol` lets a vector send a request for another pair. */
  sub(channel: Channel, symbol = 'BTC/USD', reqId = ++this.reqId): number {
    const params = channel === 'book' ? { channel, symbol: [symbol], depth: 100, snapshot: true } : channel === 'trade' ? { channel, symbol: [symbol], snapshot: false } : { channel, snapshot: true };
    this.push('subscribe', { request: JSON.stringify({ method: 'subscribe', params, req_id: reqId }) });
    return reqId;
  }
  ping(): number {
    const reqId = ++this.reqId;
    this.push('ping', { request: JSON.stringify({ method: 'ping', req_id: reqId }) });
    return reqId;
  }
  ack(reqId: number, channel: Channel, opts: { symbol?: string | null; depth?: number; success?: boolean; timed?: boolean; snapshot?: boolean; times?: [string, string] } = {}): number {
    const result: Record<string, unknown> = { channel };
    if (channel === 'book') result.depth = opts.depth ?? 100;
    if (channel !== 'instrument' && opts.symbol !== null) result.symbol = opts.symbol ?? 'BTC/USD';
    if (opts.snapshot !== undefined) result.snapshot = opts.snapshot;
    const [tin, tout] = opts.times ?? ['2026-10-06T12:00:00.100000Z', '2026-10-06T12:00:00.100050Z'];
    const times = opts.timed === false ? {} : { time_in: tin, time_out: tout };
    return this.push('message', { stream: 'method:subscribe', payload: JSON.stringify({ method: 'subscribe', req_id: reqId, result, success: opts.success ?? true, ...times }) });
  }
  pong(reqId: number, timed = false): number {
    const times = timed ? { time_in: '2026-10-06T12:00:30.000000Z', time_out: '2026-10-06T12:00:30.000020Z' } : {};
    return this.push('message', { stream: 'method:pong', payload: JSON.stringify({ method: 'pong', req_id: reqId, ...times }) });
  }
  instrument(type: 'snapshot' | 'update' = 'snapshot', pair: Pair = {}): number {
    // Built as text so the increments keep the lexemes a vector gives them.
    const p = { symbol: 'BTC/USD', status: 'online', qtyPrecision: 8, pricePrecision: 1, qtyIncrement: '0.00000001', priceIncrement: '0.1', ...pair };
    const entry = `{"symbol":"${p.symbol}","base":"BTC","quote":"USD","status":"${p.status}","qty_precision":${p.qtyPrecision},"price_precision":${p.pricePrecision},"qty_increment":${p.qtyIncrement},"price_increment":${p.priceIncrement},"qty_min":0.00005}`;
    return this.push('message', { stream: 'instrument', payload: `{"channel":"instrument","type":"${type}","data":{"assets":[],"pairs":[${entry}]}}` });
  }
  book(type: 'snapshot' | 'update' = 'update', symbol = 'BTC/USD'): number {
    return this.push('message', { stream: 'book', payload: `{"channel":"book","type":"${type}","data":[{"symbol":"${symbol}","bids":[{"price":62710.4,"qty":0.25}],"asks":[{"price":62710.5,"qty":0.5}],"checksum":1234567890,"timestamp":"2026-10-06T12:00:01.000000Z"}]}` });
  }
  trade(...symbols: string[]): number {
    const items = (symbols.length ? symbols : ['BTC/USD']).map((s, k) => `{"symbol":"${s}","side":"buy","price":62710.5,"qty":0.0012,"ord_type":"market","trade_id":${1000 + k},"timestamp":"2026-10-06T12:00:01.000000Z"}`);
    return this.push('message', { stream: 'trade', payload: `{"channel":"trade","type":"update","data":[${items.join(',')}]}` });
  }
  /** A REST probe sent `sentBeforeMs` before its response record (40 ms by default), with the example payload or `payload`. */
  probe(sentBeforeMs = 40, payload?: string): number {
    const { type: _t, recvWallMs: _w, recvMonoNs: _m, ...rest } = structuredClone(examples.probe);
    const i = this.push('probe', payload === undefined ? rest : { ...rest, payload });
    const r = this.records[i]!;
    r.sentWallMs = r.recvWallMs - sentBeforeMs;
    r.sentMonoNs = String(BigInt(r.recvMonoNs) - BigInt(sentBeforeMs) * 1_000_000n);
    return i;
  }
  /** Opens a socket that passes its subscription gate, then a book snapshot, an update and a trade. */
  /** Opens a socket that passes its subscription gate, then a book snapshot, an update (its first event) and a trade. */
  subscribedSocket(opts: { timed?: boolean } = {}): { open: number; gate: number; update: number; trade: number } {
    const open = this.open();
    const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, this.sub(c)] as const);
    for (const [c, id] of ids) this.ack(id, c, { timed: opts.timed ?? true });
    const gate = this.instrument();
    this.book('snapshot');
    const update = this.book();
    const trade = this.trade();
    return { open, gate, update, trade };
  }
  /** A raw record whose text the test gives, as a request of the given type. */
  request(type: 'subscribe' | 'unsubscribe' | 'ping', text: string): number {
    return this.push(type, { request: text });
  }
  /** Closes the current raw file and opens the next (file_end, then file_start); end() fills in their values. */
  rotate(): this {
    this.push('file_end', { fileIndex: 0, records: 0, sha256: '0'.repeat(64) });
    this.push('file_start', { fileIndex: 1, previousFileSha256: '0'.repeat(64) });
    return this;
  }
  /**
   * Ends the stream with file_end and manifest_end, then fills in every file record from the records actually written:
   * each file is one JSON.stringify(record) + '\n' line per record, a file_end's sha256 is the SHA-256 of its file's
   * bytes before it and its records their count, a file_start names the previous file's hash, and manifest_end lists
   * every file and counts the records by type. So a normalizer's R1b hash checks pass on every vector.
   */
  end(): RawRecord[] {
    this.push('file_end', { fileIndex: 0, records: 0, sha256: '0'.repeat(64) });
    const { type: _t2, recvWallMs: _w2, recvMonoNs: _m2, ...me } = structuredClone(examples.manifest_end);
    this.push('manifest_end', me);
    const files: { fileIndex: number; sha256: string; records: number }[] = [];
    let lines: string[] = [];
    const counts: Record<string, number> = {};
    for (const r of this.records) {
      if (r.type === 'manifest_end') break;
      counts[r.type] = (counts[r.type] ?? 0) + 1;
      if (r.type === 'file_end') {
        const sha256 = createHash('sha256').update(lines.join('')).digest('hex');
        Object.assign(r, { fileIndex: files.length, records: lines.length, sha256 });
        files.push({ fileIndex: files.length, sha256, records: lines.length });
        lines = [];
        continue;
      }
      if (r.type === 'file_start') Object.assign(r, { fileIndex: Math.max(files.length, 1), previousFileSha256: files[files.length - 1]?.sha256 ?? '0'.repeat(64) });
      lines.push(JSON.stringify(r) + '\n');
    }
    Object.assign(this.records[this.records.length - 1]!, { files, counts });
    return this.records;
  }
}

const schemaValid = (records: RawRecord[]): void => {
  for (const [i, r] of records.entries()) expect(captureRecord(r), `record ${i} (${r.type}): ${JSON.stringify(captureRecord.errors?.[0])}`).toBe(true);
};
const inWindow = (report: ReturnType<typeof analyzeCapture>, index: number): boolean => report.sockets.some((s) => s.window !== null && index >= s.window[0] && index <= s.window[1]);

describe('M1: a segment never spans a socket settlement and never covers a socket before its gate (R9, R10)', () => {
  it('refuses the reported interleaving: records written between the two records of a settlement', () => {
    const t = new Tape();
    t.subscribedSocket();
    const err = t.error('network_error');
    const between = t.book('snapshot');
    t.book();
    t.close('network_error');
    t.open();
    const early = t.trade();
    for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
    t.instrument();
    t.book('snapshot');
    t.book();
    t.trade();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.refused).toMatchObject({ rule: 'R10', at: between, reason: expect.stringMatching(`began at record ${err}`) });
    expect(r.fixtureEligible).toBe(false);
    expect(inWindow(r, early)).toBe(false);
  });

  it('with a well-formed settlement, keeps each window inside one socket and after that socket gate', () => {
    const t = new Tape();
    const a = t.subscribedSocket();
    const err = t.error('network_error');
    t.close('network_error');
    const bOpen = t.open();
    const bIds = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
    const early = t.trade(); // B's trade before any of B's acknowledgements
    const acks = bIds.map(([c, id]) => t.ack(id, c));
    const bGate = t.instrument();
    t.book('snapshot');
    const bTrade = t.trade();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.refused).toBeNull();
    expect(r.sockets).toHaveLength(2);
    const [sa, sb] = r.sockets;
    expect(sa).toMatchObject({ open: a.open, settlement: err, gate: a.gate, refused: null, window: [a.gate + 1, err - 1] });
    expect(sb).toMatchObject({ open: bOpen, gate: bGate, refused: null, window: [bGate + 1, sb!.settlement - 1] });
    expect(sa!.window![1]).toBeLessThan(bOpen);
    for (const i of [early, ...acks, bGate]) expect(inWindow(r, i)).toBe(false);
    expect(inWindow(r, bTrade)).toBe(true);
    expect(r.fixtureEligible).toBe(true);
  });

  it('gives an incomplete socket no window: a missing acknowledgement, or a missing instrument snapshot on a reconnection', () => {
    // A missing trade acknowledgement, with every other part of the gate present.
    let t = new Tape();
    t.open();
    const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
    for (const [c, id] of ids) if (c !== 'trade') t.ack(id, c);
    t.instrument();
    t.book('snapshot');
    let trade = t.trade();
    t.close('capture_end');
    let records = t.end();
    schemaValid(records);
    let r = analyzeCapture(records, BTC);
    expect(r.refused).toBeNull();
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/gate never passed/), window: null });
    expect(inWindow(r, trade)).toBe(false);
    expect(r.fixtureEligible).toBe(false);
    // All three acknowledgements but no instrument snapshot, on a reconnection after a qualifying socket.
    t = new Tape();
    t.subscribedSocket();
    t.close('liveness_timeout');
    t.open();
    for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
    t.book('snapshot');
    t.book();
    trade = t.trade();
    t.close('capture_end');
    records = t.end();
    schemaValid(records);
    r = analyzeCapture(records, BTC);
    expect(r.refused).toBeNull();
    expect(r.sockets.map((s) => s.refused === null)).toEqual([true, false]);
    expect(r.sockets[1]).toMatchObject({ refused: expect.stringMatching(/gate never passed/), window: null });
    expect(inWindow(r, trade)).toBe(false);
  });

  it.each(['subscribe_ack_timeout', 'snapshot_timeout', 'instrument_snapshot_timeout'])('refuses a socket settled by %s even when every frame arrived before that record', (detail) => {
    const t = new Tape();
    t.subscribedSocket();
    t.close(detail);
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    // The instrument snapshot before the timeout still counts as the capture's first (online here), so no R5.
    expect(r.refused).toBeNull();
    expect(r.sockets[0]).toMatchObject({ refused: `settled by ${detail}`, window: null });
    expect(r.fixtureEligible).toBe(false);
  });

  it('keeps the qualifying socket of a capture whose reconnection never passes its gate', () => {
    const t = new Tape();
    const a = t.subscribedSocket();
    const close = t.close('connection_lost:1006');
    t.open();
    t.sub('book');
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.sockets.map((s) => s.refused === null)).toEqual([true, false]);
    expect(r.sockets[0]!.window).toEqual([a.gate + 1, close - 1]);
    expect(r.fixtureEligible).toBe(true);
  });

  it.each<[string, (t: Tape) => void, RegExp]>([
    ['a second record the table does not pair with the first', (t) => { t.subscribedSocket(); t.error('network_error'); t.close('liveness_timeout'); }, /not followed directly by ws_close network_error/],
    ['a file rotation inside a two-record settlement', (t) => { t.subscribedSocket(); t.error('subscribe_rejected'); t.rotate(); t.close('subscribe_rejected'); }, /not followed directly/],
    ['a message between a settlement and the next ws_open', (t) => { t.subscribedSocket(); t.close('liveness_timeout'); t.trade(); t.subscribedSocket(); t.close('capture_end'); }, /message record outside an open socket/],
    ['a request before any socket opens', (t) => { t.sub('book'); t.subscribedSocket(); t.close('capture_end'); }, /subscribe record outside an open socket/],
    ['a ws_open after the capture ended', (t) => { t.subscribedSocket(); t.close('capture_end'); t.open(); }, /ws_open record after the capture ended/],
    ['a clock-step note after an end settlement (the runner writes none there, section 8.1)', (t) => { t.subscribedSocket(); t.stepWall(500); t.close('capture_end'); t.push('note', { detail: 'clock step detected' }); }, /note record after the capture ended/],
    ['a ws_open while the previous socket has no terminal record', (t) => { t.subscribedSocket(); t.subscribedSocket(); t.close('capture_end'); }, /previous socket has no terminal record/],
    ['a ws_close while no socket is open', (t) => { t.subscribedSocket(); t.close('liveness_timeout'); t.close('liveness_timeout'); }, /ws_close liveness_timeout while no socket is open/],
    ['a ws_error the table writes only while connecting, on an open socket', (t) => { t.subscribedSocket(); t.error('connect_timeout'); }, /no row of the lifecycle table writes on an open socket/],
    ['a last socket with no terminal record', (t) => { t.subscribedSocket(); }, /last socket has no terminal record/],
  ])('refuses %s (R10)', (_name, build, reason) => {
    const t = new Tape();
    build(t);
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.refused).toMatchObject({ rule: 'R10', reason: expect.stringMatching(reason) });
    expect(r.fixtureEligible).toBe(false);
  });

  it('refuses a manifest_end that does not directly follow the last file_end (R10)', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('capture_end');
    const { type: _t, recvWallMs: _w, recvMonoNs: _m, ...me } = structuredClone(examples.manifest_end);
    t.push('manifest_end', me);
    schemaValid(t.records);
    expect(analyzeCapture(t.records, BTC).refused).toMatchObject({ rule: 'R10', reason: expect.stringMatching(/manifest_end that does not follow the last file_end/) });
  });

  it('accepts a clock step first visible on the end settlement when nothing but file_end and manifest_end follows it', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.stepWall(500);
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC)).toMatchObject({ refused: null, fixtureEligible: true });
  });

  it.each<[string, (t: Tape) => void, RegExp]>([
    ['a record after a file_end that is not the next file_start (outside every file hash)', (t) => { t.subscribedSocket(); t.push('file_end', { fileIndex: 0, records: 0, sha256: '0'.repeat(64) }); t.trade(); t.close('capture_end'); }, /a message record after a file_end, outside every file hash/],
    ['a file_start that does not follow a file_end', (t) => { t.subscribedSocket(); t.push('file_start', { fileIndex: 1, previousFileSha256: '0'.repeat(64) }); t.close('capture_end'); }, /file_start that does not follow a file_end/],
    ['a note after the last file_end, before manifest_end (R1b at the note, not R10)', (t) => { t.subscribedSocket(); t.close('capture_end'); t.push('file_end', { fileIndex: 0, records: 0, sha256: '0'.repeat(64) }); t.push('note', { detail: 'late' }); }, /a note record after a file_end, outside every file hash/],
  ])('refuses %s (R1b)', (_name, build, reason) => {
    const t = new Tape();
    build(t);
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R1b', reason: expect.stringMatching(reason) });
  });

  it('accepts a file rotation between sockets and inside a socket, outside any settlement', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.rotate();
    t.trade();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC)).toMatchObject({ refused: null, fixtureEligible: true });
  });

  it('writes vectors whose file hashes are real: each file_end hashes its file\'s lines, so a normalizer\'s R1b hash checks pass', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.rotate();
    t.trade();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const text = records.map((r) => JSON.stringify(r) + '\n');
    const ends = records.flatMap((r, i) => (r.type === 'file_end' ? [i] : []));
    expect(ends).toHaveLength(2);
    const file0 = text.slice(0, ends[0]).join('');
    const file1 = text.slice(ends[0]! + 1, ends[1]).join('');
    const sha = (x: string): string => createHash('sha256').update(x).digest('hex');
    expect(records[ends[0]!]).toMatchObject({ fileIndex: 0, records: ends[0], sha256: sha(file0) });
    expect(records[ends[0]! + 1]).toMatchObject({ type: 'file_start', fileIndex: 1, previousFileSha256: sha(file0) });
    expect(records[ends[1]!]).toMatchObject({ fileIndex: 1, records: ends[1]! - ends[0]! - 1, sha256: sha(file1) });
    expect(records[records.length - 1]).toMatchObject({ files: [{ fileIndex: 0, sha256: sha(file0) }, { fileIndex: 1, sha256: sha(file1) }] });
  });

  it('accepts a failed attempt that never opened, followed by a reconnection that qualifies', () => {
    const t = new Tape();
    t.error('connect_failed');
    t.error('connect_timeout');
    t.subscribedSocket();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.refused).toBeNull();
    expect(r.sockets).toHaveLength(1);
    expect(r.fixtureEligible).toBe(true);
  });
});

describe('M2: every request, response and instrument snapshot matches the selected instrument (R9, R5, R4, R6)', () => {
  const socketWith = (build: (t: Tape) => void): ReturnType<typeof analyzeCapture> => {
    const t = new Tape();
    build(t);
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    return analyzeCapture(records, BTC);
  };
  const standard = (t: Tape, over: { trade?: { symbol?: string; ack?: string | null }; bookDepth?: number; ackChannel?: Channel } = {}): void => {
    t.open();
    const book = t.sub('book');
    const trade = t.sub('trade', over.trade?.symbol ?? 'BTC/USD');
    const instr = t.sub('instrument');
    t.ack(book, 'book', { depth: over.bookDepth ?? 100 });
    t.ack(trade, over.ackChannel ?? 'trade', { symbol: over.trade?.ack === undefined ? 'BTC/USD' : over.trade.ack });
    t.ack(instr, 'instrument');
    t.instrument();
    t.book('snapshot');
    t.trade();
  };

  it('refuses a socket whose trade request names another pair, even when it is acknowledged', () => {
    const r = socketWith((t) => standard(t, { trade: { symbol: 'ETH/USD', ack: 'ETH/USD' } }));
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/whose text is not its section 8.1 row for BTC\/USD/), window: null });
    expect(r.fixtureEligible).toBe(false);
  });

  it('compares a request with its row byte for byte: reordered keys, spacing or a number written another way refuse the socket (R9), not the capture', () => {
    for (const text of [
      '{"req_id":1,"method":"subscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":100,"snapshot":true}}',
      '{"method":"subscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":1.0e2,"snapshot":true},"req_id":1}',
      '{"method":"unsubscribe","params":{"channel":"trade","symbol":["ETH/USD"]},"method":"subscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":100,"snapshot":true},"req_id":1}',
      '{"method":"subscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":100,"snapshot":true},"req_id":01}',
    ]) {
      const r = socketWith((t) => {
        t.open();
        t.request('subscribe', text);
        t.ack(1, 'book');
        t.instrument();
      });
      expect(r.refused).toBeNull();
      expect(r.sockets[0]!.refused).toMatch(/whose text is not its section 8.1 row/);
    }
  });

  it('refuses a socket whose request record\'s type is not the method of its text (a subscribe record carrying the ping row)', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.close('liveness_timeout');
      t.open();
      t.request('subscribe', '{"method":"ping","req_id":9}');
    });
    expect(r.sockets.map((s) => s.refused === null)).toEqual([true, false]);
    expect(r.sockets[1]!.refused).toMatch(/whose text is not its section 8.1 row/);
  });

  it('refuses only the socket, not the capture, for a request without a req_id on a reconnection', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.close('liveness_timeout');
      t.open();
      t.request('ping', '{"method":"ping"}');
    });
    expect(r.refused).toBeNull();
    expect(r.sockets.map((s) => s.refused === null)).toEqual([true, false]);
    expect(r.fixtureEligible).toBe(true);
  });

  it('refuses a socket whose acknowledgement names another pair than its request', () => {
    const r = socketWith((t) => standard(t, { trade: { ack: 'ETH/USD' } }));
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/names another method or subscription than its request/), window: null });
  });

  it('refuses an acknowledgement for another channel or another book depth', () => {
    expect(socketWith((t) => standard(t, { ackChannel: 'book' })).sockets[0]!.refused).toMatch(/names another method or subscription/);
    expect(socketWith((t) => standard(t, { bookDepth: 10 })).sockets[0]!.refused).toMatch(/names another method or subscription/);
  });

  it('accepts an acknowledgement that echoes no symbol (the official CLI models result.symbol as optional)', () => {
    const r = socketWith((t) => standard(t, { trade: { ack: null } }));
    expect(r.sockets[0]!.refused).toBeNull();
    expect(r.fixtureEligible).toBe(true);
  });

  it('does not compare what a request never named: a symbol on the instrument acknowledgement, a depth on the trade acknowledgement', () => {
    const r = socketWith((t) => {
      t.open();
      const [book, trade, instr] = [t.sub('book'), t.sub('trade'), t.sub('instrument')];
      t.ack(book, 'book');
      t.push('message', { stream: 'method:subscribe', payload: JSON.stringify({ method: 'subscribe', req_id: trade, result: { channel: 'trade', symbol: 'BTC/USD', depth: 10 }, success: true }) });
      t.push('message', { stream: 'method:subscribe', payload: JSON.stringify({ method: 'subscribe', req_id: instr, result: { channel: 'instrument', symbol: 'ETH/USD' }, success: true }) });
      t.instrument();
    });
    expect(r.sockets[0]!.refused).toBeNull();
  });

  it('does not count an acknowledgement that answers no request of the socket', () => {
    const r = socketWith((t) => {
      t.open();
      t.sub('book');
      t.sub('instrument');
      t.ack(1, 'book');
      t.ack(99, 'trade');
      t.ack(2, 'instrument');
      t.instrument();
    });
    expect(r.sockets[0]!.refused).toMatch(/gate never passed/);
  });

  it('refuses a socket whose response answers its request with another method, a pong to a subscribe included', () => {
    for (const method of ['unsubscribe', 'pong']) {
      const r = socketWith((t) => {
        t.open();
        const [book, trade, instr] = [t.sub('book'), t.sub('trade'), t.sub('instrument')];
        t.ack(book, 'book');
        t.push('message', { stream: `method:${method}`, payload: JSON.stringify({ method, req_id: trade, result: { channel: 'trade', symbol: 'BTC/USD' }, success: true }) });
        t.ack(instr, 'instrument');
        t.instrument();
      });
      expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/names another method or subscription/), window: null });
    }
  });

  it('refuses a socket that receives a second response to an answered request (unknown venue behaviour, fail closed)', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.ack(1, 'book');
    });
    expect(r.sockets[0]).toMatchObject({ refused: 'a second response to req_id 1', window: null });
  });

  it('counts only the acknowledgement of the initial subscription: an acked resync subscribe does not pass a gate the initial one never passed', () => {
    const r = socketWith((t) => {
      t.open();
      t.sub('book');
      const [trade, instr] = [t.sub('trade'), t.sub('instrument')];
      t.ack(trade, 'trade');
      t.ack(instr, 'instrument');
      t.instrument();
      t.request('unsubscribe', `{"method":"unsubscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":100},"req_id":4}`);
      t.ack(t.sub('book', 'BTC/USD', 5), 'book');
    });
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/gate never passed/), window: null });
  });

  it('takes the capture-start status from the capture\'s first instrument snapshot, whichever socket delivers it (R5)', () => {
    for (const pair of [{ symbol: 'ETH/USD' }, { status: 'maintenance' }]) {
      const r = socketWith((t) => {
        t.error('connect_failed'); // an attempt that never opened
        t.open();
        const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
        for (const [c, id] of ids) t.ack(id, c);
        t.instrument('snapshot', pair);
        t.book('snapshot');
        t.book();
      });
      expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/in the capture's first instrument snapshot/) });
      expect(r.fixtureEligible).toBe(false);
    }
  });

  it('counts a snapshot the tie rule wrote before instrument_snapshot_timeout as the capture\'s first (R5 when it is not online)', () => {
    const r = socketWith((t) => {
      t.open();
      for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
      t.book('snapshot');
      t.instrument('snapshot', { status: 'cancel_only' });
      t.close('instrument_snapshot_timeout');
      t.subscribedSocket();
    });
    expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/status cancel_only, in the capture's first instrument snapshot/) });
  });

  it('refuses the capture when the capture\'s first snapshot arrives on a later socket and is not online, though a third socket qualifies (R5)', () => {
    const r = socketWith((t) => {
      t.open();
      for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
      t.close('instrument_snapshot_timeout');
      t.open();
      for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
      t.instrument('snapshot', { status: 'maintenance' });
      t.close('liveness_timeout');
      t.subscribedSocket();
    });
    expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/status maintenance, in the capture's first instrument snapshot/) });
    expect(r.fixtureEligible).toBe(false);
  });

  it('compares a snapshot echo too: true on book and instrument acknowledgements, false on trade; an absent echo is no mismatch', () => {
    const build = (snap: { book?: boolean; trade?: boolean; instrument?: boolean }) => socketWith((t) => {
      t.open();
      const [book, trade, instr] = [t.sub('book'), t.sub('trade'), t.sub('instrument')];
      t.ack(book, 'book', snap.book === undefined ? {} : { snapshot: snap.book });
      t.ack(trade, 'trade', snap.trade === undefined ? {} : { snapshot: snap.trade });
      t.ack(instr, 'instrument', snap.instrument === undefined ? {} : { snapshot: snap.instrument });
      t.instrument();
    });
    expect(build({ book: true, trade: false, instrument: true }).sockets[0]!.refused).toBeNull();
    for (const bad of [{ book: false }, { trade: true }, { instrument: false }]) expect(build(bad).sockets[0]!.refused).toMatch(/names another method or subscription/);
  });

  it('when the first socket delivers no instrument snapshot, the reconnection\'s snapshot is the capture\'s first', () => {
    const r = socketWith((t) => {
      t.open();
      for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
      t.close('instrument_snapshot_timeout');
      t.subscribedSocket();
    });
    expect(r.refused).toBeNull();
    expect(r.sockets.map((s) => s.refused === null)).toEqual([false, true]);
    expect(r.fixtureEligible).toBe(true);
  });

  it('refuses the capture when it has no instrument snapshot at all (R5: the channel gives no specification)', () => {
    const r = socketWith((t) => {
      t.open();
      for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
      t.book('snapshot');
      t.book();
    });
    expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/no instrument snapshot/) });
  });

  it('refuses a reconnection whose first instrument snapshot lacks the pair or gives it a status other than online (R9)', () => {
    for (const pair of [{ symbol: 'ETH/USD' }, { status: 'cancel_only' }]) {
      const r = socketWith((t) => {
        t.subscribedSocket();
        t.close('liveness_timeout');
        t.open();
        const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
        for (const [c, id] of ids) t.ack(id, c);
        t.instrument('snapshot', pair);
        t.book('snapshot');
      });
      expect(r.refused).toBeNull();
      expect(r.sockets.map((s) => s.refused === null)).toEqual([true, false]);
      expect(r.sockets[1]!.refused).toMatch(/no entry for BTC\/USD|status cancel_only/);
    }
  });

  it('refuses the capture when a later instrument snapshot on the same socket lacks the pair (R5)', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.instrument('snapshot', { symbol: 'ETH/USD' });
    });
    expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/later instrument snapshot has no entry/) });
  });

  it('refuses the whole capture when any instrument frame changes the precision or an increment (R5)', () => {
    for (const [type, pair] of [['snapshot', { qtyPrecision: 6 }], ['snapshot', { qtyIncrement: '0.000001' }], ['update', { priceIncrement: '0.01' }]] as const) {
      const r = socketWith((t) => {
        t.subscribedSocket();
        t.instrument(type, pair);
      });
      expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/another precision or increment/) });
      expect(r.fixtureEligible).toBe(false);
    }
  });

  it('compares increments by value, not by lexeme', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.instrument('update', { qtyIncrement: '1e-08', priceIncrement: '0.10' });
    });
    expect(r.refused).toBeNull();
    expect(canonicalDecimal('1e-08')).toBe('0.00000001');
    expect(canonicalDecimal('0.10')).toBe('0.1');
    expect(canonicalDecimal('1.5E2')).toBe('150');
  });

  it('never lets another pair\'s items pass as the selected instrument: foreign trade items and book messages in a window are listed', () => {
    let trade = -1;
    let book = -1;
    const r = socketWith((t) => {
      t.subscribedSocket();
      trade = t.trade('BTC/USD', 'ETH/USD');
      book = t.book('update', 'ETH/USD');
    });
    expect(r.refused).toBeNull();
    expect(r.foreignTradeItems).toEqual([{ at: trade, item: 1 }]);
    expect(r.foreignBookRecords).toEqual([book]);
  });

  it('lists no foreign item that section 5.5 precedence, R9 or section 5.8 counts otherwise', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.push('message', { stream: 'trade', payload: '{"channel":"trade","type":"snapshot","data":[{"symbol":"ETH/USD","side":"buy","price":2500.1,"qty":0.5,"ord_type":"limit","trade_id":7,"timestamp":"2026-10-06T12:00:01.000000Z"}]}' }); // tradeSnapshotHistory
      t.close('liveness_timeout');
      t.open();
      t.book('update', 'ETH/USD'); // before the gate: no segment is open, so no cut
      t.trade('ETH/USD'); // on a socket R9 refuses: socketNotSubscribed
    });
    expect(r.sockets.map((s) => s.refused === null)).toEqual([true, false]);
    expect(r.foreignTradeItems).toEqual([]);
    expect(r.foreignBookRecords).toEqual([]);
  });

  it('refuses a req_id that does not exceed every earlier req_id of the capture (R10)', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('liveness_timeout');
    t.open();
    t.sub('book', 'BTC/USD', 1);
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    expect(r.refused).toMatchObject({ rule: 'R10', reason: expect.stringMatching(/req_id does not exceed/) });
  });
});

describe('M3: which clock samples a segment owns (section 5.6, R2b, protocol I6)', () => {
  it('a segment owns its socket acknowledgements, which always precede it, and needs no timed pong (valid millisecond path)', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: true });
    const p = t.ping();
    t.pong(p, false);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    const owned = ownedClockSamples(records, r.sockets[0]!, a.update, end);
    expect(owned.ws).toHaveLength(3);
    expect(owned.ws.every((i) => i < a.update)).toBe(true);
    expect(owned.source).toBe('ws_method_response');
  });

  it('computes the estimate exactly: integer microseconds, truncating division, nearest-rank medians, three decimals', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: true });
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, a.update, end);
    // Requests at wall base + 30, 40 and 50 ms, acknowledgements at base + 60, 70 and 80 ms; the venue's time_in is
    // base + 100 ms and time_out base + 100.050 ms. Offsets ((100000 - 30000) + (100050 - 60000)) / 2 = 55025 us, then
    // 45025 and 35025 us; the nearest-rank median is the second smallest; every round trip is 30000 - 50 = 29950 us.
    expect(clockEstimate(records, owned)).toEqual({ samples: 3, medianMs: '45.025', medianRttMs: '29.950', maxAbsMs: '55.025', resolutionMs: 1, source: 'ws_method_response' });
    expect(rfc3339Micros('2026-10-06T12:00:00.100050Z')).toBe(1791288000100050n);
    expect(rfc3339Micros('2026-10-06T12:00:00.1Z')).toBe(1791288000100000n);
    expect(rfc3339Micros('2026-10-06 12:00:00Z')).toBeUndefined();
  });

  it('takes the nearest-rank median of an even count as the lower middle value (the ceil(count / 2)-th smallest)', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: true });
    t.pong(t.ping(), true);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, a.update, end);
    expect(owned.ws).toHaveLength(4);
    // The three acknowledgement offsets of the estimate test (35025, 45025 and 55025 us) and the pong's, sent at base +
    // 130 ms and answered at base + 140 ms with venue times 30 s later: ((30000000 - 130000) + (30000020 - 140000)) / 2
    // = 29865010 us. The second smallest of the four is 45025 us (the third, 55025, would be the upper middle).
    expect(clockEstimate(records, owned)).toMatchObject({ samples: 4, medianMs: '45.025', maxAbsMs: '29865.010' });
  });

  it('truncates each offset toward zero: a floor, ceil or rounding division gives other values', () => {
    const run = (times: [string, string]) => {
      const t = new Tape();
      t.open();
      const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
      for (const [c, id] of ids) t.ack(id, c, { times });
      t.instrument();
      t.book('snapshot');
      const first = t.book();
      t.close('capture_end');
      const records = t.end();
      return clockEstimate(records, ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, first, first));
    };
    // Sums of -89997, -109997 and -129997 us: halves of -44998.5, -54998.5 and -64998.5 truncate toward zero.
    expect(run(['2026-10-06T12:00:00.000001Z', '2026-10-06T12:00:00.000002Z'])).toEqual({ samples: 3, medianMs: '-54.998', medianRttMs: '29.999', maxAbsMs: '64.998', resolutionMs: 1, source: 'ws_method_response' });
    // Sums of 110051, 90051 and 70051 us: halves of 55025.5, 45025.5 and 35025.5 truncate down.
    expect(run(['2026-10-06T12:00:00.100001Z', '2026-10-06T12:00:00.100050Z'])).toEqual({ samples: 3, medianMs: '45.025', medianRttMs: '29.951', maxAbsMs: '55.025', resolutionMs: 1, source: 'ws_method_response' });
  });

  it('counts only real calendar instants in the upper-case RFC 3339 form: no impossible date, hour 24, leap second or lower-case t and z', () => {
    for (const bad of ['2026-02-30T12:00:00.100000Z', '2026-10-06T24:00:00Z', '2016-12-31T23:59:60Z', '2026-10-06t12:00:00z', '2026-10-06T12:00:00+24:00', '2026-10-06T12:60:00Z']) expect(rfc3339Micros(bad), bad).toBeUndefined();
    expect(rfc3339Micros('2024-02-29T00:00:00Z')).toBe(BigInt(Date.UTC(2024, 1, 29)) * 1000n);
    expect(rfc3339Micros('2026-10-06T14:00:00.000001+02:00')).toBe(1791288000000001n);
  });

  it('owns no sample of another socket and none after its own end record', () => {
    const t = new Tape();
    t.subscribedSocket({ timed: true });
    t.close('liveness_timeout');
    const b = t.subscribedSocket({ timed: false });
    const end = t.book();
    for (let k = 0; k < 3; k++) t.pong(t.ping(), true);
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    const owned = ownedClockSamples(records, r.sockets[1]!, b.update, end);
    expect(owned.ws).toEqual([]);
    expect(owned.source).toBe('none');
  });

  it('falls back to a usable REST probe received within 15 minutes before the segment, with the coarse estimate at 1 s resolution', () => {
    const t = new Tape();
    // The venue's second 1791288001 against a host that sent at base - 20 ms and received at base + 20 ms.
    const probe = t.probe(40, '{"error":[],"result":{"unixtime":1791288001,"rfc1123":"Tue, 06 Oct 26 12:00:01 +0000"}}');
    t.advance(14 * 60_000);
    const b = t.subscribedSocket({ timed: false });
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    const owned = ownedClockSamples(records, r.sockets[0]!, b.update, end);
    expect(owned).toEqual({ epoch: 0, ws: [], wsRequests: [], rest: [probe], source: 'rest_time' });
    // t1 = t2 = base + 1500000 us (the middle of the reported second); offset ((1500000 + 20000) + (1500000 - 20000)) / 2.
    expect(clockEstimate(records, owned)).toEqual({ samples: 1, medianMs: '1500.000', medianRttMs: '40.000', maxAbsMs: '1500.000', resolutionMs: 1000, source: 'rest_time' });
  });

  it('counts no unusable sample: a probe whose payload is an error, and a response whose time_in is not an RFC 3339 instant', () => {
    const t = new Tape();
    t.probe(40, '{"error":["EService:Unavailable"]}');
    const open = t.open();
    const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
    for (const [c, id] of ids) t.push('message', { stream: 'method:subscribe', payload: JSON.stringify({ method: 'subscribe', req_id: id, result: c === 'instrument' ? { channel: c } : c === 'book' ? { channel: c, symbol: 'BTC/USD', depth: 100 } : { channel: c, symbol: 'BTC/USD' }, success: true, time_in: 'yesterday', time_out: '2026-10-06T12:00:00.100050Z' }) });
    t.instrument();
    t.book('snapshot');
    const first = t.book();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.sockets[0]).toMatchObject({ open, refused: null });
    expect(ownedClockSamples(records, r.sockets[0]!, first, first)).toMatchObject({ ws: [], rest: [], source: 'none' });
  });

  it('fails closed with no sample: untimed acknowledgements and pongs and no recent probe give source none (R2b refuses)', () => {
    const t = new Tape();
    t.probe();
    t.advance(16 * 60_000);
    const b = t.subscribedSocket({ timed: false });
    const p = t.ping();
    t.pong(p, false);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    const owned = ownedClockSamples(records, r.sockets[0]!, b.update, end);
    expect(owned).toEqual({ epoch: 0, ws: [], wsRequests: [], rest: [], source: 'none' });
    expect(clockEstimate(records, owned)).toBeNull();
  });

  it('counts timed pongs inside the segment, and rejects a segment outside its socket window', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: false });
    for (let k = 0; k < 3; k++) t.pong(t.ping(), true);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    expect(ownedClockSamples(records, r.sockets[0]!, a.update, end).source).toBe('ws_method_response');
    expect(() => ownedClockSamples(records, r.sockets[0]!, a.gate, end)).toThrow(/inside its socket window/);
  });

  it('owns no sample from before a clock step: the post-step segment falls back to a probe sent after the step, or to none', () => {
    for (const withProbe of [false, true]) {
      const t = new Tape();
      t.subscribedSocket({ timed: true });
      const straddling = t.probe(); // received before the step
      t.stepWall(500);
      const step = t.book(); // the clock cut: the next segment starts here
      const beforeProbe = withProbe ? t.advance(100).probe() : -1;
      const end = t.book();
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      expect(clockSteps(records)).toEqual([step]);
      const r = analyzeCapture(records, BTC);
      const owned = ownedClockSamples(records, r.sockets[0]!, step, end);
      expect(owned.epoch).toBe(step);
      expect(owned.ws).toEqual([]);
      expect(owned.rest).not.toContain(straddling);
      expect(owned).toMatchObject(withProbe ? { rest: [beforeProbe], source: 'rest_time' } : { rest: [], source: 'none' });
    }
  });

  it('owns no acknowledgement whose request precedes a clock step, even when the acknowledgement follows it', () => {
    const t = new Tape();
    t.open();
    const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
    t.stepWall(50);
    const step = t.ack(ids[0]![1], 'book');
    t.ack(ids[1]![1], 'trade');
    t.ack(ids[2]![1], 'instrument');
    t.instrument();
    t.book('snapshot');
    const first = t.book();
    t.close('capture_end');
    const records = t.end();
    expect(clockSteps(records)).toEqual([step]);
    const r = analyzeCapture(records, BTC);
    expect(ownedClockSamples(records, r.sockets[0]!, first, first)).toMatchObject({ epoch: step, ws: [], source: 'none' });
  });

  it('starts the epoch at a step between the baseline snapshot and the first event, which no segment spans', () => {
    const t = new Tape();
    t.open();
    for (const c of ['book', 'trade', 'instrument'] as Channel[]) t.ack(t.sub(c), c);
    t.instrument();
    t.book('snapshot');
    t.stepWall(500);
    const step = t.push('message', { stream: 'heartbeat', payload: '{"channel":"heartbeat"}' });
    const first = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    expect(ownedClockSamples(records, r.sockets[0]!, first, first)).toMatchObject({ epoch: step, ws: [] });
  });

  it('excludes a probe sent before the step and received after it, and refuses a segment that spans a step', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: true });
    t.stepWall(500);
    const step = t.probe(5); // its send clock precedes the step record, which is itself
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    expect(ownedClockSamples(records, r.sockets[0]!, step, end)).toMatchObject({ epoch: step, rest: [], source: 'none' });
    expect(() => ownedClockSamples(records, r.sockets[0]!, a.update, end)).toThrow(/never spans a clock step/);
  });
});
