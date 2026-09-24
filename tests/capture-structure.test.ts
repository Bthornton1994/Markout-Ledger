// Vectors for the structural capture rules (docs/M2_DATA_CONTRACT.md sections 5.3, 5.6, 5.8, 5.9 and 8.1) checked by
// tests/capture-structure.ts. Every record is built from the constructed examples of schemas/examples and must be valid
// against schemas/capture-record.v1.schema.json, so each vector is a raw stream the runner could write. The values are
// invented for the tests; none is venue data. PR-1's normalizer must reach the same verdicts (handoff A7(r)).
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { analyzeCapture, canonicalDecimal, clockSteps, ownedClockSamples, type RawRecord, type SelectedInstrument } from './capture-structure.js';

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
  ack(reqId: number, channel: Channel, opts: { symbol?: string | null; depth?: number; success?: boolean; timed?: boolean } = {}): number {
    const result: Record<string, unknown> = { channel };
    if (channel === 'book') result.depth = opts.depth ?? 100;
    if (channel !== 'instrument' && opts.symbol !== null) result.symbol = opts.symbol ?? 'BTC/USD';
    const times = opts.timed === false ? {} : { time_in: '2026-10-06T12:00:00.100000Z', time_out: '2026-10-06T12:00:00.100050Z' };
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
  /** A REST probe sent `sentBeforeMs` before its response record (40 ms by default). */
  probe(sentBeforeMs = 40): number {
    const { type: _t, recvWallMs: _w, recvMonoNs: _m, ...rest } = structuredClone(examples.probe);
    const i = this.push('probe', rest);
    const r = this.records[i]!;
    r.sentWallMs = r.recvWallMs - sentBeforeMs;
    r.sentMonoNs = String(BigInt(r.recvMonoNs) - BigInt(sentBeforeMs) * 1_000_000n);
    return i;
  }
  /** Opens a socket that passes its subscription gate, then a book snapshot, an update and a trade. */
  subscribedSocket(opts: { timed?: boolean } = {}): { open: number; gate: number; trade: number } {
    const open = this.open();
    const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, this.sub(c)] as const);
    for (const [c, id] of ids) this.ack(id, c, { timed: opts.timed ?? true });
    const gate = this.instrument();
    this.book('snapshot');
    this.book();
    const trade = this.trade();
    return { open, gate, trade };
  }
  end(): RawRecord[] {
    const { type: _t, recvWallMs: _w, recvMonoNs: _m, ...fe } = structuredClone(examples.file_end);
    this.push('file_end', { ...fe, records: this.records.length });
    const { type: _t2, recvWallMs: _w2, recvMonoNs: _m2, ...me } = structuredClone(examples.manifest_end);
    this.push('manifest_end', me);
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

  it('gives an incomplete socket no window: a missing instrument snapshot, or a missing acknowledgement', () => {
    for (const missing of ['instrument', 'trade'] as const) {
      const t = new Tape();
      t.open();
      const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
      for (const [c, id] of ids) if (c !== missing) t.ack(id, c);
      if (missing !== 'instrument') t.instrument();
      t.book('snapshot');
      const trade = t.trade();
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      const r = analyzeCapture(records, BTC);
      expect(r.refused).toBeNull();
      expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/gate never passed/), window: null });
      expect(inWindow(r, trade)).toBe(false);
      expect(r.fixtureEligible).toBe(false);
    }
  });

  it('refuses a socket settled by a gate timeout even when every frame arrived before the timeout record', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('subscribe_ack_timeout');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.sockets[0]).toMatchObject({ refused: 'settled by subscribe_ack_timeout', window: null });
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
    ['a file rotation inside a two-record settlement', (t) => { t.subscribedSocket(); t.error('subscribe_rejected'); t.push('file_end', { fileIndex: 0, records: 99, sha256: 'b'.repeat(64) }); t.close('subscribe_rejected'); }, /not followed directly/],
    ['a message between a settlement and the next ws_open', (t) => { t.subscribedSocket(); t.close('liveness_timeout'); t.trade(); t.subscribedSocket(); t.close('capture_end'); }, /message record outside an open socket/],
    ['a request before any socket opens', (t) => { t.sub('book'); t.subscribedSocket(); t.close('capture_end'); }, /subscribe record outside an open socket/],
    ['a ws_open after the capture ended', (t) => { t.subscribedSocket(); t.close('capture_end'); t.open(); }, /ws_open record after the capture ended/],
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

describe('M2: every acknowledgement and instrument snapshot matches the selected instrument (R9, R5, R4, R6)', () => {
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
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/not the section 8.1 request for BTC\/USD/), window: null });
    expect(r.fixtureEligible).toBe(false);
  });

  it('refuses a socket whose acknowledgement names another pair than its request', () => {
    const r = socketWith((t) => standard(t, { trade: { ack: 'ETH/USD' } }));
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/names another subscription than its request/), window: null });
  });

  it('refuses an acknowledgement for another channel or another book depth', () => {
    expect(socketWith((t) => standard(t, { ackChannel: 'book' })).sockets[0]!.refused).toMatch(/names another subscription/);
    expect(socketWith((t) => standard(t, { bookDepth: 10 })).sockets[0]!.refused).toMatch(/names another subscription/);
  });

  it('accepts an acknowledgement that echoes no symbol (the official CLI models result.symbol as optional)', () => {
    const r = socketWith((t) => standard(t, { trade: { ack: null } }));
    expect(r.sockets[0]!.refused).toBeNull();
    expect(r.fixtureEligible).toBe(true);
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

  it('refuses a reconnection whose instrument snapshot lacks the pair or gives it a status other than online', () => {
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

  it('never lets another pair\'s items pass as the selected instrument: foreign trade items and book messages are listed', () => {
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

  it('refuses the whole capture when the first socket\'s instrument snapshot lacks the pair or gives it a status other than online (R5)', () => {
    for (const pair of [{ symbol: 'ETH/USD' }, { status: 'maintenance' }]) {
      const r = socketWith((t) => {
        t.open();
        const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
        for (const [c, id] of ids) t.ack(id, c);
        t.instrument('snapshot', pair);
        t.book('snapshot');
        t.book();
      });
      expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/first socket/) });
      expect(r.fixtureEligible).toBe(false);
    }
  });

  it('refuses the capture when a later instrument snapshot on the same socket lacks the pair (R5)', () => {
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.instrument('snapshot', { symbol: 'ETH/USD' });
    });
    expect(r.refused).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/later instrument snapshot has no entry/) });
  });

  it('refuses a socket whose acknowledgement answers its request with another method', () => {
    const r = socketWith((t) => {
      t.open();
      const book = t.sub('book');
      const trade = t.sub('trade');
      const instr = t.sub('instrument');
      t.ack(book, 'book');
      t.push('message', { stream: 'method:unsubscribe', payload: JSON.stringify({ method: 'unsubscribe', req_id: trade, result: { channel: 'trade', symbol: 'BTC/USD' }, success: true }) });
      t.ack(instr, 'instrument');
      t.instrument();
    });
    expect(r.sockets[0]).toMatchObject({ refused: expect.stringMatching(/names another subscription/), window: null });
  });

  it('dispatches on the frame, never on the record\'s stream label: a foreign trade filed under another label is still found', () => {
    let at = -1;
    const r = socketWith((t) => {
      t.subscribedSocket();
      const i = t.trade('ETH/USD');
      t.records[i]!.stream = 'unknown';
      at = i;
    });
    expect(r.foreignTradeItems).toEqual([{ at, item: 0 }]);
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
    const owned = ownedClockSamples(records, r.sockets[0]!, a.gate + 1, end);
    expect(owned.ws).toHaveLength(3);
    expect(owned.ws.every((i) => i < a.gate + 1)).toBe(true);
    expect(owned.source).toBe('ws_method_response');
  });

  it('owns no sample of another socket and none after its own end record', () => {
    const t = new Tape();
    t.subscribedSocket({ timed: true });
    t.close('liveness_timeout');
    const b = t.subscribedSocket({ timed: false });
    const end = t.book();
    const late = t.ping();
    t.pong(late, true);
    t.pong(late, true);
    t.pong(late, true);
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    const owned = ownedClockSamples(records, r.sockets[1]!, b.gate + 1, end);
    expect(owned.ws).toEqual([]);
    expect(owned.source).toBe('none');
  });

  it('falls back to a REST probe received within 15 minutes before the segment, at 1 s resolution', () => {
    const t = new Tape();
    const probe = t.probe();
    t.advance(14 * 60_000);
    const b = t.subscribedSocket({ timed: false });
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    const owned = ownedClockSamples(records, r.sockets[0]!, b.gate + 1, end);
    expect(owned).toEqual({ epoch: 0, ws: [], rest: [probe], source: 'rest_time' });
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
    expect(ownedClockSamples(records, r.sockets[0]!, b.gate + 1, end)).toEqual({ epoch: 0, ws: [], rest: [], source: 'none' });
  });

  it('counts timed pongs inside the segment, and rejects a segment outside its socket window', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: false });
    for (let k = 0; k < 3; k++) t.pong(t.ping(), true);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    const r = analyzeCapture(records, BTC);
    expect(ownedClockSamples(records, r.sockets[0]!, a.gate + 1, end).source).toBe('ws_method_response');
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
    expect(() => ownedClockSamples(records, r.sockets[0]!, a.gate + 1, end)).toThrow(/never spans a clock step/);
  });
});
