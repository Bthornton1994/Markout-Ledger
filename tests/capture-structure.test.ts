// Vectors for the structural capture rules (docs/M2_DATA_CONTRACT.md sections 5.3, 5.6, 5.8, 5.9 and 8.1) checked by
// tests/capture-structure.ts. Every record is built from the constructed examples of schemas/examples and must be valid
// against schemas/capture-record.v1.schema.json, so each vector is a raw stream the runner could write. The values are
// invented for the tests; none is venue data. PR-1's normalizer must reach the same verdicts (handoff A7(r)).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { afterAll, describe, expect, it, type RunnerTask, type RunnerTestCase } from 'vitest';
import { analyzeCapture as analyzeCaptureReference, canonicalDecimal, clockEstimate, clockSteps, ownedClockSamples, rfc3339Micros, type RawRecord, type SelectedInstrument } from './capture-structure.js';

const addFormats = addFormatsModule.default;
const repoRoot = new URL('../', import.meta.url);
const readJson = (path: string): any => JSON.parse(readFileSync(new URL(path, repoRoot), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv, ['date', 'date-time', 'uuid']);
const captureRecord = ajv.compile(readJson('schemas/capture-record.v1.schema.json'));
const examples = readJson('schemas/examples/capture-record.v1.examples.json').examples;

/**
 * Every raw stream a vector gives the reference, in order, for handoff A7(r). PR-1 changes neither this file nor
 * tests/capture-structure.ts (contract section 5.11), so its test takes the streams from here: run with
 * CAPTURE_VECTORS_OUT set to a directory outside the repository, this file writes there, once its vectors have run, one
 * `<n>.jsonl` per stream (one JSON.stringify(record) plus '\n' per record, in stream order: its raw files one after
 * another, each ending with its `file_end`) and `vectors.json`, which lists each file with the test that built it and the
 * selected instrument the reference judged it for. The streams are constructed, not venue data, but they are raw capture
 * records, which A10 refuses in the tree, so the export refuses a directory inside the repository (also through a link),
 * a path through a dangling link, an empty value, and a run of this file in which a test failed or did not run (a -t
 * filter included), and writes only into a new directory or an existing empty one that is not a link, creating every file
 * exclusively, so it never writes through a link or hard link planted there. Every
 * book frame of every stream carries the checksum contract section 8.2 computes, verified again before export, so a
 * normalizer's checksum verification passes and never keeps it from the segment, window and clock rules a vector tests.
 */
const judged: { test: string; instrument: SelectedInstrument; records: RawRecord[] }[] = [];
const analyzeCapture = (records: RawRecord[], instrument: SelectedInstrument): ReturnType<typeof analyzeCaptureReference> => {
  judged.push({ test: expect.getState().currentTestName ?? '', instrument: structuredClone(instrument), records: structuredClone(records) });
  return analyzeCaptureReference(records, instrument);
};
const repoRootPath = fileURLToPath(repoRoot);
const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
/** `path` with its longest existing prefix resolved through symbolic links, so a link into the repository is seen as such;
 * a dangling link on the path makes it throw. */
const realPath = (path: string): string => {
  let head = resolve(path);
  const rest: string[] = [];
  while (lstatOrNull(head) === null) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
};
/** Whether a resolved path lies outside the repository (a name that merely starts with '..' is inside it). */
const outsideRepository = (path: string): boolean => {
  const rel = relative(realpathSync(repoRootPath), path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};
/**
 * Creates `path` and writes all of `data`, failing if anything exists there, a link or a hard-linked file included
 * (O_EXCL). The file is recorded in `created` as soon as it exists; a write that stores fewer bytes than asked is
 * continued until every byte is written, and one that stores none is an error.
 */
const writeNew = (path: string, data: string, created: string[] = []): void => {
  const fd = openSync(path, 'wx');
  created.push(path);
  let failure: unknown;
  try {
    const bytes = Buffer.from(data, 'utf8');
    for (let done = 0; done < bytes.length; ) {
      const n = exportIo.writeSync(fd, bytes, done, bytes.length - done);
      if (n <= 0) throw new Error(`CAPTURE_VECTORS_OUT: a write to ${path} stored nothing (${done} of ${bytes.length} bytes written)`);
      done += n;
    }
  } catch (e) {
    failure = e;
  }
  // A close that fails is an error too, but never in place of the write's own.
  try {
    exportIo.closeSync(fd);
  } catch (e) {
    failure ??= e;
  }
  if (failure !== undefined) throw failure;
};
/** The system calls the export makes after creating a file; a test replaces them to make a write or a close fail, or a
 * write store fewer bytes than asked. */
const exportIo = {
  writeSync: (fd: number, buffer: Buffer, offset: number, length: number): number => writeSync(fd, buffer, offset, length),
  closeSync: (fd: number): void => closeSync(fd),
};
/** What a run of this file did: the tests that failed, and the tests it did not run (filtered out with `-t`, `.only` or a
 * `.skip`), apart from the two that only exercise the export and are skipped in a run that exports. */
type RunOutcome = { failed: string[]; skipped: string[] };
const EXPORT_HARNESS = new Set(['export self-test: a failing test', 'writes every stream the reference judges when CAPTURE_VECTORS_OUT names a directory outside the repository, end to end']);
/**
 * Writes the judged streams to `out` for PR-1 (handoff A7(r)), or throws: an empty value, a value
 * with a '..' segment, a path through a dangling link, a target inside the repository (also through a link), a run in
 * which a test failed or was not run (so the streams are every vector, each judged by a passing test), a stream whose
 * book checksums section 8.2 does not verify, or a target that exists and is not an empty directory (a link to one
 * included) is refused before any file is written. Every file is created exclusively, so a link or hard link planted in
 * the directory is never written through, and a write that fails removes the files and directories the export created
 * (a clean-up that fails too is reported with the write's error). Two limits: a bind mount of the repository is not recognized as the repository (A10's tree test refuses the raw streams
 * it holds once they are staged, and the opt-in pre-push hook and CI refuse them in the ranges they scan, contract section
 * 6.5), and a process killed during the writes leaves the files written so far.
 */
function exportVectors(out: string, streams: typeof judged, run: RunOutcome): void {
  if (out.trim() === '') throw new Error('CAPTURE_VECTORS_OUT is set but empty: name a directory outside the repository, or unset it');
  // path.resolve reads a '..' segment lexically, the file system after following the link before it, so the two could
  // name different directories: a value with one is refused before anything is resolved.
  if (out.split(/[\\/]/).includes('..')) throw new Error(`CAPTURE_VECTORS_OUT must not contain a '..' segment: ${out}`);
  let resolved: string;
  try {
    resolved = realPath(out);
  } catch {
    throw new Error(`CAPTURE_VECTORS_OUT cannot be resolved (a dangling link on its path, for example): ${out}`);
  }
  if (!outsideRepository(resolved)) throw new Error(`CAPTURE_VECTORS_OUT must be outside the repository: ${out}`);
  if (run.failed.length > 0) throw new Error(`CAPTURE_VECTORS_OUT: ${run.failed.length} test(s) failed (${run.failed.join('; ')}), so no stream is exported`);
  if (run.skipped.length > 0) throw new Error(`CAPTURE_VECTORS_OUT: ${run.skipped.length} test(s) did not run (${run.skipped.join('; ')}); run the whole file, so every vector is exported`);
  for (const [k, v] of streams.entries()) {
    const { failed: bad } = replayBookChecksums(v.records, v.instrument.symbol);
    if (bad.length > 0) throw new Error(`CAPTURE_VECTORS_OUT: stream ${k} (${v.test}) has book frames whose section 8.2 checksum fails, at ${bad.join(', ')}`);
  }
  // The target itself may not be a link (lstat of the value as written would follow one named with a trailing '/' or
  // '/.'); from here on every call names the resolved directory, so what was checked is what is written.
  if (lstatOrNull(resolve(out))?.isSymbolicLink()) throw new Error(`CAPTURE_VECTORS_OUT must be a new directory or an existing empty one that is not a link: ${out}`);
  const found = lstatOrNull(resolved);
  let created = false;
  /** The first directory mkdir created (the target or one of its parents), up to which a rollback removes. */
  let firstCreated: string | undefined;
  const removeCreated = (): void => {
    if (!created) return;
    for (let d = resolved; ; d = dirname(d)) {
      rmdirSync(d);
      if (d === (firstCreated ?? resolved)) break;
    }
  };
  if (found === null) {
    firstCreated = mkdirSync(resolved, { recursive: true });
    created = true;
  } else if (!found.isDirectory() || readdirSync(resolved).length > 0) {
    throw new Error(`CAPTURE_VECTORS_OUT must be a new directory or an existing empty one that is not a link: ${out}`);
  }
  // Checked again on the directory itself, against a link swapped in between the check above and mkdir (defence in depth:
  // without such a race the two checks agree).
  if (!outsideRepository(realpathSync(resolved))) {
    removeCreated();
    throw new Error(`CAPTURE_VECTORS_OUT must be outside the repository: ${out}`);
  }
  // A write that fails removes the files this export created (each exclusively, so each is its own) and every directory it
  // made, so a failed export leaves no vector unless that clean-up fails too, which it reports.
  const written: string[] = [];
  try {
    const index = streams.map((v, k) => {
      const file = `${String(k).padStart(3, '0')}.jsonl`;
      writeNew(join(resolved, file), v.records.map((r) => JSON.stringify(r) + '\n').join(''), written);
      return { file, test: v.test, instrument: v.instrument };
    });
    writeNew(join(resolved, 'vectors.json'), JSON.stringify(index, null, 2) + '\n', written);
  } catch (e) {
    // Each file is recorded as soon as it exists, so one whose write failed is removed too. A clean-up that fails is
    // reported with the error that caused it, never in its place.
    try {
      for (const path of written) rmSync(path, { force: true });
      removeCreated();
    } catch (cleanup) {
      throw new Error(`${(e as Error).message}; removing what the export wrote also failed, so it may be left: ${(cleanup as Error).message}`, { cause: e });
    }
    throw e;
  }
}
/** What this run did, read from the file's tasks once every test has run. */
const runOutcome = (file: Readonly<RunnerTask>): RunOutcome => {
  const tests = (task: Readonly<RunnerTask>): Readonly<RunnerTestCase>[] => (task.type === 'test' ? [task] : task.tasks.flatMap(tests));
  const all = tests(file);
  return {
    failed: all.filter((t) => t.result?.state === 'fail').map((t) => t.name),
    skipped: all.filter((t) => t.result?.state !== 'fail' && t.result?.state !== 'pass' && !(t.mode === 'skip' && EXPORT_HARNESS.has(t.name))).map((t) => t.name),
  };
};
afterAll(({}, file) => {
  const out = process.env.CAPTURE_VECTORS_OUT;
  if (out !== undefined) exportVectors(out, judged, runOutcome(file));
});

/** CRC-32 of the IEEE 802.3 polynomial (the zlib and binascii CRC-32), table-driven and written here independently of node:zlib, which a test compares it with (contract section 8.2, step 3). */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(text: string): number {
  let c = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A book level as the wire gave it: [price lexeme, qty lexeme]. */
type Level = [string, string];
/** Section 8.2 step 2: a wire lexeme without its decimal point, then without its leading zeros. */
const checksumPart = (lexeme: string): string => lexeme.replace('.', '').replace(/^0+/, '');
/** Section 8.2 steps 1 to 3: the top 10 asks from the lowest price, then the top 10 bids from the highest, each level's price then quantity part, CRC-32 of the concatenation. Prices compare as numbers, exact for the lexemes these vectors use. */
function bookChecksum(asks: Level[], bids: Level[]): number {
  const top = (side: Level[], dir: 1 | -1): Level[] => [...side].sort((a, b) => dir * (Number(a[0]) - Number(b[0]))).slice(0, 10);
  return crc32([...top(asks, 1), ...top(bids, -1)].map(([p, q]) => checksumPart(p) + checksumPart(q)).join(''));
}
/** A local book as section 8.2 keeps it: per side, the lexemes of the message that last set each price level, truncated to the subscribed depth (100). */
class LexemeBook {
  readonly asks = new Map<string, Level>();
  readonly bids = new Map<string, Level>();
  apply(side: 'asks' | 'bids', levels: Level[]): void {
    for (const [price, qty] of levels) {
      if (Number(qty) === 0) this[side].delete(canonicalDecimal(price));
      else this[side].set(canonicalDecimal(price), [price, qty]);
    }
    const kept = [...this[side].entries()].sort((a, b) => (side === 'asks' ? 1 : -1) * (Number(a[1][0]) - Number(b[1][0]))).slice(0, 100);
    this[side].clear();
    for (const [key, level] of kept) this[side].set(key, level);
  }
  checksum(): number {
    return bookChecksum([...this.asks.values()], [...this.bids.values()]);
  }
}
/** Exact comparison of two unsigned decimal lexemes, independent of Number (the replay's own ordering). */
const compareDecimal = (a: string, b: string): number => {
  const [ai = '', af = ''] = canonicalDecimal(a).split('.');
  const [bi = '', bf = ''] = canonicalDecimal(b).split('.');
  const width = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(width, '0'));
  const y = BigInt(bi + bf.padEnd(width, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
};
/** Section 8.2's checksum built a second way, for the replay: its own ordering, its own concatenation and node:zlib's CRC-32. */
function independentBookChecksum(asks: Level[], bids: Level[]): number {
  const strip = (lexeme: string): string => lexeme.split('.').join('').replace(/^0*/, '');
  const sortedAsks = [...asks].sort((a, b) => compareDecimal(a[0], b[0])).slice(0, 10);
  const sortedBids = [...bids].sort((a, b) => compareDecimal(b[0], a[0])).slice(0, 10);
  let text = '';
  for (const [p, q] of [...sortedAsks, ...sortedBids]) text += strip(p) + strip(q);
  return zlibCrc32(Buffer.from(text, 'utf8')) >>> 0;
}
/** The five-level book of contract section 8.2, whose checksum the contract publishes: 1396696505. */
const FIVE_BOOK = { asks: [['62710.5', '0.93111634'], ['62710.6', '0.50000000'], ['62711.0', '1.20000000']] as Level[], bids: [['62710.4', '0.01000000'], ['62709.1', '2.00000000']] as Level[] };
/**
 * A book twelve levels deep on each side. Its checksum is 2975579563, the CRC32 of DEEP_BOOK_TOP10: that string was written
 * by hand from section 8.2's rule, the ten lowest asks then the ten highest bids (the eleventh and twelfth levels of each
 * side are not in it), and its CRC32 computed with Python's binascii.crc32. Without its best ask, so that the eleventh enters
 * the top ten, 1703851086.
 */
const DEEP_BOOK = {
  asks: [['62710.5', '0.50000000'], ['62710.6', '0.12000000'], ['62710.7', '1.00000000'], ['62710.8', '0.00031000'], ['62710.9', '2.50000000'], ['62711.0', '0.75000000'], ['62711.1', '0.01000000'], ['62711.2', '3.00000000'], ['62711.3', '0.00000500'], ['62711.4', '1.10000000'], ['62711.5', '0.20000000'], ['62711.6', '4.00000000']] as Level[],
  bids: [['62710.4', '0.25000000'], ['62710.3', '0.60000000'], ['62710.2', '1.50000000'], ['62710.1', '0.00200000'], ['62710.0', '2.00000000'], ['62709.9', '0.03000000'], ['62709.8', '0.40000000'], ['62709.7', '5.00000000'], ['62709.6', '0.00000100'], ['62709.5', '0.90000000'], ['62709.4', '0.70000000'], ['62709.3', '6.00000000']] as Level[],
};
const DEEP_BOOK_TOP10 = '627105500000006271061200000062710710000000062710831000627109250000000627110750000006271111000000627112300000000627113500627114110000000627104250000006271036000000062710215000000062710120000062710020000000062709930000006270984000000062709750000000062709610062709590000000';
/** The checksum a book frame record carries for its first element. */
const frameChecksum = (record: RawRecord): number => Number(JSON.parse(record.payload as string).data[0].checksum);
/**
 * Replays a stream's book frames as section 8.2's synchronization does, with its own book and checksum, and returns the
 * stream indices of the book elements it verified and of those it failed: per socket, elements before its first snapshot
 * are not verified (dropped.depthBeforeSnapshot), a snapshot replaces the book, an update is applied (a zero quantity
 * deletes the level), and after a failure nothing is verified until the next snapshot; an element of another pair is
 * malformed (R6) and never verified.
 */
function replayBookChecksums(records: RawRecord[], symbol = 'BTC/USD'): { verified: number[]; failed: number[]; snapshots: number[]; updates: number[] } {
  const out = { verified: [] as number[], failed: [] as number[], snapshots: [] as number[], updates: [] as number[] };
  let book: { asks: Map<string, Level>; bids: Map<string, Level> } | null = null;
  for (const [i, r] of records.entries()) {
    if (r.type === 'ws_open') book = null;
    if (r.type !== 'message' || r.stream !== 'book' || typeof r.payload !== 'string') continue;
    let frame: any;
    try {
      frame = JSON.parse(r.payload, ((_key: string, value: unknown, context?: { source?: string }) => (typeof value === 'number' && context?.source !== undefined ? context.source : value)) as (key: string, value: unknown) => unknown);
    } catch {
      continue;
    }
    for (const element of Array.isArray(frame?.data) ? frame.data : []) {
      if (element?.symbol !== symbol) continue;
      const levels = (side: unknown): Level[] => (Array.isArray(side) ? side.map((l: any) => [String(l.price), String(l.qty)] as Level) : []);
      if (frame.type === 'snapshot') book = { asks: new Map(), bids: new Map() };
      else if (book === null) continue;
      for (const [side, list] of [['asks', levels(element.asks)], ['bids', levels(element.bids)]] as const) {
        for (const [price, qty] of list) {
          if (compareDecimal(qty, '0') === 0) book[side].delete(canonicalDecimal(price));
          else book[side].set(canonicalDecimal(price), [price, qty]);
        }
      }
      (frame.type === 'snapshot' ? out.snapshots : out.updates).push(i);
      if (independentBookChecksum([...book.asks.values()], [...book.bids.values()]) === Number(element.checksum)) out.verified.push(i);
      else {
        out.failed.push(i);
        book = null;
      }
    }
  }
  return out;
}

/**
 * Replays every stream's book checksums as section 8.2 defines them (none may fail) and counts what a normalizer that
 * verifies them reaches: verified snapshots and updates, the first segment of each socket (its first verified update
 * inside the socket's window, ending before the next clock step, where R3 cuts) and those segments whose owned clock
 * samples yield an estimate, a lower bound, since a later segment after a clock cut is not counted. Not vacuous: the
 * vectors reach many of each, as a normalizer that checks every checksum would find.
 */
function expectReach(streams: { test: string; instrument: SelectedInstrument; records: RawRecord[] }[], what: string): void {
  let snapshots = 0;
  let updates = 0;
  let segments = 0;
  let estimates = 0;
  const checksums = new Set<number>();
  for (const [k, v] of streams.entries()) {
    // Each stream is replayed for its own instrument. The tape builds books only for BTC/USD, so every vector with book
    // frames is a BTC/USD vector and this per-instrument replay is exercised only by the export's another-pair case.
    const replay = replayBookChecksums(v.records, v.instrument.symbol);
    expect(replay.failed, `stream ${k}: ${v.test}`).toEqual([]);
    snapshots += replay.snapshots.length;
    updates += replay.updates.length;
    for (const i of replay.verified) checksums.add(frameChecksum(v.records[i]!));
    const report = analyzeCaptureReference(v.records, v.instrument);
    if (report.refused !== null) continue;
    for (const socket of report.sockets) {
      if (socket.refused !== null || socket.window === null) continue;
      const [from, to] = socket.window;
      const first = replay.verified.find((i) => replay.updates.includes(i) && i >= from && i <= to);
      if (first === undefined) continue;
      segments += 1;
      const step = clockSteps(v.records).find((s) => s > first) ?? Infinity;
      const last = Math.max(...replay.verified.filter((i) => i >= first && i <= to && i < step));
      if (clockEstimate(v.records, ownedClockSamples(v.records, socket, first, last)) !== null) estimates += 1;
    }
  }
  expect(streams.length, what).toBeGreaterThan(150);
  expect(snapshots, what).toBeGreaterThan(150);
  expect(updates, what).toBeGreaterThan(180);
  expect(segments, what).toBeGreaterThan(60);
  expect(estimates, what).toBeGreaterThan(45);
  // Many book states, among them the two whose checksums are known from outside this code: the contract's five-level
  // book and the twelve-level book, so a tape that writes one value, or code that keeps more than ten levels, fails here.
  expect(checksums.has(1396696505) && checksums.has(2975579563), what).toBe(true);
  expect(checksums.size, what).toBeGreaterThanOrEqual(6);
}

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
  /** The local book the tape's book frames build (section 8.2), reset at every ws_open. */
  private localBook = new LexemeBook();
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
    this.localBook = new LexemeBook();
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
  /** The book unsubscribe row of section 8.1; returns its req_id. */
  unsub(symbol = 'BTC/USD', reqId = ++this.reqId): number {
    this.push('unsubscribe', { request: JSON.stringify({ method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: 100 }, req_id: reqId }) });
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
  /** An instrument frame with one pair entry, `pair` over the selected instrument's values, and any further entries. */
  instrument(type: 'snapshot' | 'update' = 'snapshot', pair: Pair = {}, ...more: Pair[]): number {
    // Built as text so the increments keep the lexemes a vector gives them.
    const entry = (q: Pair): string => {
      const p = { symbol: 'BTC/USD', status: 'online', qtyPrecision: 8, pricePrecision: 1, qtyIncrement: '0.00000001', priceIncrement: '0.1', ...q };
      return `{"symbol":"${p.symbol}","base":"BTC","quote":"USD","status":"${p.status}","qty_precision":${p.qtyPrecision},"price_precision":${p.pricePrecision},"qty_increment":${p.qtyIncrement},"price_increment":${p.priceIncrement},"qty_min":0.00005}`;
    };
    return this.push('message', { stream: 'instrument', payload: `{"channel":"instrument","type":"${type}","data":{"assets":[],"pairs":[${[pair, ...more].map(entry).join(',')}]}}` });
  }
  /**
   * A book frame whose levels keep the lexemes given here and whose checksum is the one section 8.2 computes over the book
   * the tape's frames build (a snapshot replaces it, an update is applied); a frame of another pair is malformed (R6) and
   * never verified, so its checksum covers its own levels. `corrupt` adds 1 to the checksum, for tests of the replay.
   */
  book(type: 'snapshot' | 'update' = 'update', symbol = 'BTC/USD', levels: { bids?: Level[]; asks?: Level[]; corrupt?: boolean } = {}): number {
    const bids = levels.bids ?? [['62710.4', '0.25']];
    const asks = levels.asks ?? [['62710.5', '0.5']];
    let checksum = bookChecksum(asks, bids);
    if (symbol === 'BTC/USD') {
      if (type === 'snapshot') this.localBook = new LexemeBook();
      this.localBook.apply('asks', asks);
      this.localBook.apply('bids', bids);
      checksum = this.localBook.checksum();
    }
    if (levels.corrupt) checksum = (checksum + 1) >>> 0;
    const side = (list: Level[]): string => list.map(([p, q]) => `{"price":${p},"qty":${q}}`).join(',');
    return this.push('message', { stream: 'book', payload: `{"channel":"book","type":"${type}","data":[{"symbol":"${symbol}","bids":[${side(bids)}],"asks":[${side(asks)}],"checksum":${checksum},"timestamp":"2026-10-06T12:00:01.000000Z"}]}` });
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
   * every file and counts the records by type. So a normalizer's R1b hash checks pass on every vector. With
   * `fileEnd: false` the last file has no file_end: manifest_end lists it with the hash of every byte of it (contract
   * section 5.10), so its missing file_end is the only fault left for the record rules (R10).
   */
  end(opts: { fileEnd?: boolean } = {}): RawRecord[] {
    const fileEnd = opts.fileEnd ?? true;
    if (fileEnd) this.push('file_end', { fileIndex: 0, records: 0, sha256: '0'.repeat(64) });
    const { type: _t2, recvWallMs: _w2, recvMonoNs: _m2, ...me } = structuredClone(examples.manifest_end);
    this.push('manifest_end', me);
    const files: { fileIndex: number; sha256: string; records: number }[] = [];
    let lines: string[] = [];
    const counts: Record<string, number> = {};
    // Every record but the last manifest_end, which no file hash covers; a manifest_end a vector wrote earlier is a line
    // of the file that follows it.
    for (const r of this.records.slice(0, -1)) {
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
    if (!fileEnd) files.push({ fileIndex: files.length, sha256: createHash('sha256').update(lines.join('')).digest('hex'), records: lines.length });
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

  it('reports a last socket with no terminal record at the manifest_end record (R10, section 5.10), with or without a last file_end', () => {
    for (const fileEnd of [true, false]) {
      const t = new Tape();
      t.subscribedSocket();
      const records = t.end({ fileEnd });
      schemaValid(records);
      expect(records[records.length - 1]!.type).toBe('manifest_end');
      // Without a file_end the manifest_end also breaks a record rule of step (2); both are R10 at that record, so only
      // the rule and the record are compared (handoff A7(r)), not which reason the reference names.
      expect(analyzeCapture(records, BTC).refused).toMatchObject(fileEnd ? { rule: 'R10', at: records.length - 1, reason: expect.stringMatching(/last socket has no terminal record/) } : { rule: 'R10', at: records.length - 1 });
    }
  });

  it('refuses a manifest_end that does not directly follow the last file_end (R10), with real hashes so step (1) passes', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('capture_end');
    const records = t.end({ fileEnd: false });
    schemaValid(records);
    expect(records.filter((r) => r.type === 'file_end')).toHaveLength(0);
    expect(records[records.length - 1]).toMatchObject({ type: 'manifest_end', files: [{ fileIndex: 0, records: records.length - 1 }] });
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R10', reason: expect.stringMatching(/manifest_end that does not follow the last file_end/) });
  });

  it('refuses a manifest_end followed by more records as R1b at that manifest_end: the file_end before it was not the last file\'s', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('capture_end');
    t.push('file_end', { fileIndex: 0, records: 0, sha256: '0'.repeat(64) });
    const { type: _t, recvWallMs: _w, recvMonoNs: _m, ...me } = structuredClone(examples.manifest_end);
    const at = t.push('manifest_end', me);
    t.push('file_start', { fileIndex: 1, previousFileSha256: '0'.repeat(64) });
    const records = t.end();
    schemaValid(records);
    expect(records.filter((r) => r.type === 'manifest_end')).toHaveLength(2);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R1b', at, reason: expect.stringMatching(/a manifest_end after a file_end that is not the last file's/) });
  });

  it('refuses a stream that does not begin with manifest_start or does not end with manifest_end (R1, before any record rule)', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('capture_end');
    const records = t.end();
    const swapped = [records[1]!, records[0]!, ...records.slice(2)];
    schemaValid(swapped);
    expect(analyzeCapture(swapped, BTC).refused).toMatchObject({ rule: 'R1', at: 0, reason: expect.stringMatching(/does not begin with manifest_start/) });
    // A missing manifest_end is R1 even when an earlier record breaks a record rule (R10 here: a trade outside a socket).
    const u = new Tape();
    u.trade();
    u.subscribedSocket();
    u.close('capture_end');
    const truncated = u.end().slice(0, -1);
    schemaValid(truncated);
    expect(analyzeCapture(truncated, BTC).refused).toMatchObject({ rule: 'R1', at: truncated.length - 1, reason: expect.stringMatching(/does not end with manifest_end/) });
    expect(analyzeCapture(u.records, BTC).refused).toMatchObject({ rule: 'R10', at: 1 });
    expect(analyzeCapture([], BTC).refused).toMatchObject({ rule: 'R1', at: 0 });
  });

  it('refuses a second manifest_start (R10)', () => {
    const t = new Tape();
    t.subscribedSocket();
    const second = t.push('manifest_start', { ...structuredClone(examples.manifest_start) });
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R10', at: second, reason: expect.stringMatching(/a second manifest_start/) });
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
    ['a file_start between the two records of a settlement (R1b before R10 at the same record, section 5.10)', (t) => { t.subscribedSocket(); t.error('network_error'); t.push('file_start', { fileIndex: 1, previousFileSha256: '0'.repeat(64) }); t.close('network_error'); }, /a file_start that does not follow a file_end/],
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

  it('neither refuses nor cuts at a later instrument snapshot on the same socket whose status is not online (its status is not compared, section 8.1)', () => {
    let later = -1;
    let trade = -1;
    const r = socketWith((t) => {
      t.subscribedSocket();
      later = t.instrument('snapshot', { status: 'maintenance' });
      trade = t.trade();
    });
    expect(r.refused).toBeNull();
    expect(r.sockets[0]!.refused).toBeNull();
    expect(inWindow(r, later)).toBe(true);
    expect(inWindow(r, trade)).toBe(true);
    expect(r.fixtureEligible).toBe(true);
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

  it('refuses the capture when an instrument frame lists the pair twice (R5), even when the first entry is correct', () => {
    for (const type of ['snapshot', 'update'] as const) {
      const r = socketWith((t) => {
        t.subscribedSocket();
        t.instrument(type, {}, { qtyPrecision: 6 });
      });
      expect(r.refused, type).toMatchObject({ rule: 'R5', reason: expect.stringMatching(/lists BTC\/USD more than once/) });
      expect(r.fixtureEligible).toBe(false);
    }
    // Two identical entries are refused as well: the rule counts entries, it does not compare them.
    const same = new Tape();
    same.open();
    const ids = (['book', 'trade', 'instrument'] as const).map((c) => [c, same.sub(c)] as const);
    for (const [c, id] of ids) same.ack(id, c);
    const at = same.instrument('snapshot', {}, {});
    same.close('capture_end');
    const records = same.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R5', at });
  });

  it('refuses the capture on a malformed instrument frame (R5): data not an object, pairs not a list, or an entry without a string symbol', () => {
    const payloads = [
      '{"channel":"instrument","type":"update","data":{"assets":[],"pairs":{"symbol":"BTC/USD","qty_precision":6}}}',
      '{"channel":"instrument","type":"update","data":{"assets":[],"pairs":["BTC/USD"]}}',
      '{"channel":"instrument","type":"update","data":{"assets":[],"pairs":[{"symbol":null,"qty_precision":6}]}}',
      '{"channel":"instrument","type":"update","data":[]}',
    ];
    for (const payload of payloads) {
      const t = new Tape();
      t.subscribedSocket();
      const at = t.push('message', { stream: 'instrument', payload });
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      expect(analyzeCapture(records, BTC).refused, payload).toMatchObject({ rule: 'R5', at, reason: expect.stringMatching(/a malformed instrument update/) });
    }
    // An update that carries no pairs key (assets only) names no pair and is not malformed.
    const r = socketWith((t) => {
      t.subscribedSocket();
      t.push('message', { stream: 'instrument', payload: '{"channel":"instrument","type":"update","data":{"assets":[]}}' });
    });
    expect(r.refused).toBeNull();
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

  it('converts the years 0000 to 0099 exactly, not as 1900 to 1999 (proleptic Gregorian; values computed independently)', () => {
    expect(rfc3339Micros('0099-01-01T00:00:00Z')).toBe(-59042995200000000n);
    expect(rfc3339Micros('0000-02-29T00:00:00Z')).toBe(-62162121600000000n);
    expect(rfc3339Micros('0099-12-31T23:59:59.123456+01:00')).toBe(-59011462800876544n);
    expect(rfc3339Micros('0001-02-29T00:00:00Z')).toBeUndefined();
  });

  it('owns a probe received exactly 15 minutes before the segment start, not one received 1 ns earlier, measured from the start record', () => {
    for (const early of [0n, 1n]) {
      const t = new Tape();
      const probe = t.probe();
      // subscribedSocket writes its update, the segment start, as its tenth record: 900000 ms after the probe.
      t.advance(900_000 - 100);
      const b = t.subscribedSocket({ timed: false });
      const end = t.book();
      t.close('capture_end');
      const r0 = t.records[probe]!;
      r0.recvMonoNs = String(BigInt(r0.recvMonoNs) - early);
      r0.sentMonoNs = String(BigInt(r0.sentMonoNs as string) - early);
      const records = t.end();
      schemaValid(records);
      expect(BigInt(records[b.update]!.recvMonoNs) - BigInt(records[probe]!.recvMonoNs)).toBe(900_000_000_000n + early);
      const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, b.update, end);
      expect(owned).toMatchObject(early === 0n ? { rest: [probe], source: 'rest_time' } : { rest: [], source: 'none' });
    }
  });

  it('owns, after a step, a probe sent exactly at the step record, and a request that is the step record, but not a probe sent 1 ns before it', () => {
    for (const early of [0n, 1n]) {
      const t = new Tape();
      t.subscribedSocket({ timed: false });
      t.stepWall(500);
      const reqId = t.ping(); // the step record is itself a request
      const step = t.records.length - 1;
      const pong = t.pong(reqId, true);
      const probe = t.probe(20); // sent 20 ms before its record: exactly the step record's monotonic clock
      const pr = t.records[probe]!;
      pr.sentMonoNs = String(BigInt(pr.sentMonoNs as string) - early);
      const start = t.book();
      const end = t.book();
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      expect(clockSteps(records)).toEqual([step]);
      expect(BigInt(records[probe]!.sentMonoNs as string)).toBe(BigInt(records[step]!.recvMonoNs) - early);
      const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, start, end);
      expect(owned).toMatchObject({ epoch: step, ws: [pong], wsRequests: [step], rest: early === 0n ? [probe] : [] });
    }
  });

  it('owns a probe that is itself the step record when its send clock equals that record\'s (a zero round trip)', () => {
    const t = new Tape();
    t.subscribedSocket({ timed: false });
    t.stepWall(500);
    const step = t.probe(0);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(clockSteps(records)).toEqual([step]);
    expect(ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, step, end)).toMatchObject({ epoch: step, rest: [step], source: 'rest_time' });
  });

  it('owns a sample at the segment end record: a pong and a probe that are the end record count', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: false });
    t.pong(t.ping(), true);
    t.pong(t.ping(), true);
    const p = t.ping();
    const lastPong = t.pong(p, true);
    const probe = t.probe();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(ownedClockSamples(records, r.sockets[0]!, a.update, lastPong)).toMatchObject({ source: 'ws_method_response' });
    expect(ownedClockSamples(records, r.sockets[0]!, a.update, lastPong).ws).toContain(lastPong);
    expect(ownedClockSamples(records, r.sockets[0]!, a.update, probe).rest).toEqual([probe]);
  });

  it('needs at least three millisecond samples: two give the probe estimate, or none without a probe', () => {
    for (const withProbe of [true, false]) {
      const t = new Tape();
      if (withProbe) t.probe();
      const a = t.subscribedSocket({ timed: false });
      t.pong(t.ping(), true);
      t.pong(t.ping(), true);
      const end = t.book();
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, a.update, end);
      expect(owned.ws).toHaveLength(2);
      expect(owned.source).toBe(withProbe ? 'rest_time' : 'none');
    }
  });

  it('drops fraction digits beyond the microsecond without rounding, and needs upper-case T and Z each on its own; offsets up to 23:59', () => {
    expect(rfc3339Micros('2026-10-06T12:00:00.1000509Z')).toBe(1791288000100050n);
    expect(rfc3339Micros('2026-10-06T12:00:00.999999999Z')).toBe(1791288000999999n);
    for (const bad of ['2026-10-06t12:00:00Z', '2026-10-06T12:00:00z']) expect(rfc3339Micros(bad), bad).toBeUndefined();
    expect(rfc3339Micros('2026-10-06T12:00:00+23:59')).toBe(1791288000000000n - 86_340_000_000n);
    expect(rfc3339Micros('2026-10-06T12:00:00-00:59')).toBe(1791288000000000n + 3_540_000_000n);
    expect(rfc3339Micros('2026-10-06T12:00:00+00:60')).toBeUndefined();
  });

  it('carries the RFC 3339 boundary forms in a stream, so the vectors hand them to a normalizer: long fractions and offsets count, the others do not', () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: false });
    const pong = (timeIn: string, timeOut: string): number => {
      const reqId = t.ping();
      return t.push('message', { stream: 'method:pong', payload: JSON.stringify({ method: 'pong', req_id: reqId, time_in: timeIn, time_out: timeOut }) });
    };
    const usable = [
      pong('2026-10-06T12:00:30.0000009Z', '2026-10-06T12:00:30.0000209Z'),
      pong('2026-10-06T12:00:30.000000999Z', '2026-10-06T12:00:30.000020999Z'),
      pong('2026-10-07T11:59:30+23:59', '2026-10-06T11:01:30.000020-00:59'),
    ];
    for (const bad of ['2026-10-06t12:00:30Z', '2026-10-06T12:00:30z', '2026-10-06T12:00:30.0000000001Z', '2026-10-06T12:00:30+0000', '2026-10-07T12:00:30+24:00', '2016-12-31T23:59:60Z']) pong(bad, bad);
    const end = t.book();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, a.update, end);
    expect(owned).toMatchObject({ ws: usable, source: 'ws_method_response' });
    expect(clockEstimate(records, owned)).toEqual({ samples: 3, medianMs: '29845.010', medianRttMs: '9.980', maxAbsMs: '29865.010', resolutionMs: 1, source: 'ws_method_response' });
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

  it('reads result.unixtime by its exact value, never through a float: an integer however written counts, a value that is not a safe integer does not', () => {
    /** The median offset the probe gives, or null when it is no sample. */
    const medianMs = (lexeme: string): string | null => {
      const t = new Tape();
      t.probe(40, `{"error":[],"result":{"unixtime":${lexeme},"rfc1123":"Tue, 06 Oct 26 12:00:01 +0000"}}`);
      const a = t.subscribedSocket({ timed: false });
      const end = t.book();
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      const owned = ownedClockSamples(records, analyzeCapture(records, BTC).sockets[0]!, a.update, end);
      return owned.source === 'rest_time' ? clockEstimate(records, owned)!.medianMs : null;
    };
    /** The offset of section 5.6 for a unixtime of `value`: the middle of that second minus the probe's midpoint, 1791288000000000 us. */
    const expected = (value: bigint): string => {
      const us = value * 1_000_000n + 500_000n - 1_791_288_000_000_000n;
      const abs = us < 0n ? -us : us;
      return `${us < 0n ? '-' : ''}${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
    };
    for (const lexeme of ['1791288001', '1791288001.0', '1.791288001e9', '17912880010e-1']) expect(medianMs(lexeme), lexeme).toBe('1500.000');
    for (const [lexeme, value] of [['0', 0n], ['-0', 0n], ['0.0e5', 0n], ['-1', -1n], ['9007199254740991', 9007199254740991n], ['-9007199254740991', -9007199254740991n]] as const) {
      expect(medianMs(lexeme), lexeme).toBe(expected(value));
    }
    for (const lexeme of ['1791288000.9999999999999999', '1791288001.00000001', '1791288001.5', '9007199254740992', '9007199254740993', '-9007199254740992', '1e400', '"1791288001"']) expect(medianMs(lexeme), lexeme).toBeNull();
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

describe('settlements that end the capture, acknowledgements, request identity and probe ownership (R9, R10, section 5.6)', () => {
  /** A capture that settles its one socket with `settle`, then runs `after`; the reference's verdict and the stream. */
  const capture = (settle: (t: Tape) => void, after: (t: Tape) => void = () => {}) => {
    const t = new Tape();
    t.subscribedSocket();
    settle(t);
    const marks = { next: t.records.length };
    after(t);
    const records = t.end();
    schemaValid(records);
    return { report: analyzeCapture(records, BTC), marks };
  };
  const ends: [string, (t: Tape) => void][] = [
    ['capture_end', (t) => void t.close('capture_end')],
    ['operator_stop', (t) => void t.close('operator_stop')],
    ['subscribe_rejected', (t) => { t.error('subscribe_rejected'); t.close('subscribe_rejected'); }],
    ['resync_budget_exhausted', (t) => { t.error('resync_budget_exhausted'); t.close('budget_exhausted'); }],
    ['reconnect_budget_exhausted', (t) => { t.close('liveness_timeout'); t.error('reconnect_budget_exhausted'); }],
  ];

  it('ends the capture at every end row of the lifecycle table: nothing but file_end and manifest_end may follow (R10)', () => {
    for (const [name, settle] of ends) {
      const ok = capture(settle).report;
      expect(ok.refused, name).toBeNull();
      const late = capture(settle, (t) => void t.open());
      expect(late.report.refused, name).toMatchObject({ rule: 'R10', at: late.marks.next, reason: expect.stringMatching(/after the capture ended/) });
      const note = capture(settle, (t) => void t.push('note', { detail: 'late' }));
      expect(note.report.refused, name).toMatchObject({ rule: 'R10', at: note.marks.next });
    }
  });

  it('settles an open socket with ws_close resync_failed in one record, and lets the capture reconnect after it', () => {
    const { report } = capture((t) => void t.close('resync_failed'), (t) => {
      t.subscribedSocket();
      t.close('capture_end');
    });
    expect(report.refused).toBeNull();
    expect(report.sockets.map((s) => [s.detail, s.refused])).toEqual([['resync_failed', null], ['capture_end', null]]);
    expect(report.fixtureEligible).toBe(true);
  });

  it('refuses a record of any kind between the two records of a settlement, a note or a probe included (R10)', () => {
    for (const between of [(t: Tape) => t.push('note', { detail: 'between' }), (t: Tape) => t.probe()]) {
      const t = new Tape();
      t.subscribedSocket();
      t.error('network_error');
      const at = between(t);
      t.close('network_error');
      t.close('capture_end');
      const records = t.end();
      schemaValid(records);
      expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R10', at, reason: expect.stringMatching(/not followed directly by ws_close network_error/) });
    }
  });

  it('settles an initial subscription answered success false immediately as subscribe_rejected, and accepts no later record', () => {
    for (const rejected of ['book', 'trade', 'instrument'] as Channel[]) {
      const late = new Tape();
      late.open();
      const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, late.sub(c)] as const);
      for (const [c, id] of ids) if (c !== rejected) late.ack(id, c);
      late.instrument();
      const bad = late.ack(ids.find(([c]) => c === rejected)![1], rejected, { success: false });
      const between = late.book();
      late.error('subscribe_rejected');
      late.close('subscribe_rejected');
      const broken = late.end();
      schemaValid(broken);
      const refused = analyzeCapture(broken, BTC);
      expect(refused.refused, rejected).toMatchObject({ rule: 'R10', at: between, reason: expect.stringMatching(`failed subscription response at record ${bad}`) });
      expect(inWindow(refused, between), rejected).toBe(false);
      expect(refused.fixtureEligible, rejected).toBe(false);

      const ok = new Tape();
      ok.open();
      const okIds = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, ok.sub(c)] as const);
      for (const [c, id] of okIds) if (c !== rejected) ok.ack(id, c);
      ok.instrument();
      ok.ack(okIds.find(([c]) => c === rejected)![1], rejected, { success: false });
      const err = ok.error('subscribe_rejected');
      ok.close('subscribe_rejected');
      const settled = ok.end();
      schemaValid(settled);
      const accepted = analyzeCapture(settled, BTC);
      expect(accepted.refused, rejected).toBeNull();
      expect(accepted.sockets, rejected).toEqual([expect.objectContaining({ settlement: err, detail: 'subscribe_rejected', window: null })]);
      expect(accepted.fixtureEligible, rejected).toBe(false);

      const again = new Tape();
      again.open();
      const againIds = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, again.sub(c)] as const);
      for (const [c, id] of againIds) if (c !== rejected) again.ack(id, c);
      again.instrument();
      again.ack(againIds.find(([c]) => c === rejected)![1], rejected, { success: false });
      again.error('subscribe_rejected');
      again.close('subscribe_rejected');
      const reconnect = again.open();
      const reopened = again.end();
      schemaValid(reopened);
      expect(analyzeCapture(reopened, BTC).refused, rejected).toMatchObject({ rule: 'R10', at: reconnect, reason: expect.stringMatching(/after the capture ended/) });
    }
  });

  it('settles a failed resync acknowledgement immediately as resync_failed, and keeps later records out of that socket', () => {
    for (const which of ['unsubscribe', 'subscribe'] as const) {
      const late = new Tape();
      late.subscribedSocket();
      const unsub = late.unsub();
      let bad: number;
      if (which === 'unsubscribe') {
        bad = late.push('message', { stream: 'method:unsubscribe', payload: JSON.stringify({ method: 'unsubscribe', req_id: unsub, result: { channel: 'book', symbol: 'BTC/USD', depth: 100 }, success: false }) });
      } else {
        late.push('message', { stream: 'method:unsubscribe', payload: JSON.stringify({ method: 'unsubscribe', req_id: unsub, result: { channel: 'book', symbol: 'BTC/USD', depth: 100 }, success: true }) });
        bad = late.ack(late.sub('book'), 'book', { success: false });
      }
      const between = late.book();
      late.close('capture_end');
      const broken = late.end();
      schemaValid(broken);
      const refused = analyzeCapture(broken, BTC);
      expect(refused.refused, which).toMatchObject({ rule: 'R10', at: between, reason: expect.stringMatching(`failed subscription response at record ${bad} is not followed directly by ws_close resync_failed`) });
      expect(inWindow(refused, between), which).toBe(false);
      expect(refused.fixtureEligible, which).toBe(false);
    }

    const t = new Tape();
    const first = t.subscribedSocket();
    const unsub = t.unsub();
    const bad = t.push('message', { stream: 'method:unsubscribe', payload: JSON.stringify({ method: 'unsubscribe', req_id: unsub, result: { channel: 'book', symbol: 'BTC/USD', depth: 100 }, success: false }) });
    const close = t.close('resync_failed');
    const second = t.subscribedSocket();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const r = analyzeCapture(records, BTC);
    expect(r.refused).toBeNull();
    expect(r.sockets.map((s) => s.detail)).toEqual(['resync_failed', 'capture_end']);
    expect(r.sockets[0]).toMatchObject({ settlement: close, window: [first.gate + 1, close - 1] });
    expect(r.sockets[0]!.window![1]).toBeLessThan(second.open);
    expect(inWindow(r, first.update)).toBe(true);
    expect(inWindow(r, bad)).toBe(true);
    expect(inWindow(r, close)).toBe(false);
    expect(inWindow(r, second.update)).toBe(true);
    expect(r.fixtureEligible).toBe(true);
  });

  it('does not settle a mismatched response, or a failed ping, as a subscription rejection', () => {
    const mismatch = new Tape();
    mismatch.open();
    const book = mismatch.sub('book');
    mismatch.sub('trade');
    mismatch.sub('instrument');
    mismatch.ack(book, 'book', { depth: 10, success: false });
    mismatch.instrument();
    mismatch.close('capture_end');
    const mismatched = mismatch.end();
    schemaValid(mismatched);
    const m = analyzeCapture(mismatched, BTC);
    expect(m.refused).toBeNull();
    expect(m.sockets[0]!.refused).toMatch(/names another method or subscription/);

    const ping = new Tape();
    ping.subscribedSocket();
    const req = ping.ping();
    ping.push('message', { stream: 'method:pong', payload: JSON.stringify({ method: 'pong', req_id: req, success: false }) });
    ping.close('capture_end');
    const pong = ping.end();
    schemaValid(pong);
    expect(analyzeCapture(pong, BTC)).toMatchObject({ refused: null, fixtureEligible: true });
  });

  it('refuses a request that reuses an earlier req_id of the capture, on the same socket or a later one (R10)', () => {
    const same = new Tape();
    same.open();
    const first = same.sub('book');
    const at = same.records.length;
    same.sub('trade', 'BTC/USD', first);
    same.close('capture_end');
    const records = same.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R10', at, reason: expect.stringMatching(/does not exceed every earlier req_id/) });

    const later = new Tape();
    later.subscribedSocket();
    later.close('liveness_timeout');
    later.open();
    const reusedAt = later.records.length;
    later.sub('book', 'BTC/USD', 3);
    later.close('capture_end');
    const again = later.end();
    schemaValid(again);
    expect(analyzeCapture(again, BTC).refused).toMatchObject({ rule: 'R10', at: reusedAt, reason: expect.stringMatching(/does not exceed every earlier req_id/) });
  });

  it("gives a segment no probe received after its last record, although it lies in the socket's window (section 5.6)", () => {
    const t = new Tape();
    const a = t.subscribedSocket({ timed: false });
    const end = t.book();
    const probe = t.probe();
    t.book();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const socket = analyzeCapture(records, BTC).sockets[0]!;
    expect(inWindow(analyzeCapture(records, BTC), probe)).toBe(true);
    const owned = ownedClockSamples(records, socket, a.update, end);
    expect(owned.rest).toEqual([]);
    expect(owned.source).toBe('none');
    // The same probe is the segment's once the segment reaches it.
    expect(ownedClockSamples(records, socket, a.update, probe + 1).rest).toEqual([probe]);
  });
});

describe('the manifest\'s REST specification (R5, sections 5.10 step (1) and 8.4)', () => {
  /** A capture with one subscribed socket whose manifest's REST AssetPairs payload is `edit` applied to the example's. */
  const withRest = (edit: (payload: any) => void, build: (t: Tape) => void = (t) => void t.subscribedSocket(), instrument: SelectedInstrument = BTC) => {
    const t = new Tape();
    const spec = t.records[0]!.instrumentSpec as { payload: string };
    const payload = JSON.parse(spec.payload);
    edit(payload);
    spec.payload = JSON.stringify(payload);
    build(t);
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    return { records, report: analyzeCapture(records, instrument) };
  };
  const entry = (p: any): any => p.result.XXBTZUSD;

  it('accepts the example payload, and one whose REST status is absent (an absent REST status is no disagreement)', () => {
    expect(withRest(() => {}).report).toMatchObject({ refused: null, fixtureEligible: true });
    expect(withRest((p) => delete entry(p).status).report).toMatchObject({ refused: null, fixtureEligible: true });
  });

  it('refuses the capture at its manifest when the REST status is present and not online (R5)', () => {
    for (const status of ['delisted', 'cancel_only', 'maintenance', '']) {
      expect(withRest((p) => (entry(p).status = status)).report.refused, status).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/gives status/) });
    }
  });

  it('refuses the capture at its manifest when REST lists the pair\'s REST name more than once, or not at all (R5)', () => {
    const twice = withRest((p) => (p.result.XBTUSD = structuredClone(entry(p)))).report.refused;
    expect(twice).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/lists XBTUSD more than once/) });
    for (const [name, edit] of [
      ['empty result', (p: any) => (p.result = {})],
      ['another pair only', (p: any) => (entry(p).altname = 'ETHUSD')],
      ['the WebSocket name, not the REST name', (p: any) => (entry(p).altname = 'XBT/USD')],
    ] as const) {
      expect(withRest(edit).report.refused, name).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/has no entry for XBTUSD/) });
    }
    // The REST name is the adapter's fixed mapping unless the caller names another; a pair with no known REST name is refused.
    expect(withRest(() => {}, undefined, { ...BTC, restName: 'XXBTZUSD' }).report.refused).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/no entry for XXBTZUSD/) });
    expect(withRest(() => {}, (t) => void t.open(), { ...BTC, symbol: 'ETH/USD' }).report.refused).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/no REST name is known/) });
  });

  it('refuses the capture at its manifest when the REST payload is not JSON, reports an error, or is not the AssetPairs shape (R5)', () => {
    const t = new Tape();
    (t.records[0]!.instrumentSpec as { payload: string }).payload = '{"error":[],"result":';
    t.subscribedSocket();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/missing, malformed or reports an error/) });
    for (const [name, edit] of [
      ['an error', (p: any) => (p.error = ['EGeneral:Temporary lockout'])],
      ['no error list', (p: any) => delete p.error],
      ['result a list', (p: any) => (p.result = [entry(p)])],
      ['no result', (p: any) => delete p.result],
    ] as const) {
      expect(withRest(edit).report.refused, name).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/missing, malformed or reports an error/) });
    }
    for (const [name, edit] of [
      ['pair_decimals a string', (p: any) => (entry(p).pair_decimals = '1')],
      ['lot_decimals missing', (p: any) => delete entry(p).lot_decimals],
      ['tick_size a number', (p: any) => (entry(p).tick_size = 0.1)],
      ['tick_size in exponent form', (p: any) => (entry(p).tick_size = '1e-1')],
    ] as const) {
      expect(withRest(edit).report.refused, name).toMatchObject({ rule: 'R5', at: 0, reason: expect.stringMatching(/lacks integer pair_decimals/) });
    }
  });

  it('refuses the capture at its first instrument snapshot when REST pair_decimals, lot_decimals or tick_size disagrees with it (R5)', () => {
    let gate = -1;
    const build = (t: Tape): void => void (gate = t.subscribedSocket().gate);
    for (const [name, edit] of [
      ['pair_decimals', (p: any) => (entry(p).pair_decimals = 2)],
      ['lot_decimals', (p: any) => (entry(p).lot_decimals = 6)],
      ['tick_size', (p: any) => (entry(p).tick_size = '0.01')],
    ] as const) {
      const { report } = withRest(edit, build);
      expect(report.refused, name).toMatchObject({ rule: 'R5', at: gate, reason: expect.stringMatching(/manifest's REST specification disagree/) });
      expect(report.fixtureEligible).toBe(false);
    }
    // tick_size is compared by value, so "0.10" agrees with 0.1.
    expect(withRest((p) => (entry(p).tick_size = '0.10'), build).report.refused).toBeNull();
    // The comparison is with the instrument channel, not only with the caller's specification: the caller agreeing with a
    // REST payload the channel contradicts is still R5.
    const { report } = withRest((p) => (entry(p).lot_decimals = 6), (t) => void (gate = t.subscribedSocket().gate), { ...BTC, qtyPrecision: 6 });
    expect(report.refused).toMatchObject({ rule: 'R5', at: gate, reason: expect.stringMatching(/manifest's REST specification disagree/) });
  });

  it('checks the manifest before any other record: a bad REST payload is found at 0 even when a later record breaks another rule', () => {
    const t = new Tape();
    const spec = t.records[0]!.instrumentSpec as { payload: string };
    spec.payload = JSON.stringify({ ...JSON.parse(spec.payload), result: {} });
    t.book('update');
    t.close('capture_end');
    const records = t.end({ fileEnd: false });
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toMatchObject({ rule: 'R5', at: 0 });
  });
});

describe('the book checksum of contract section 8.2, which every vector book frame carries', () => {
  const WORKED = '45285210000045286415457195345286615457110945289615456091145290215890660452918154553491452947445474945296135380000452975994554245299518772827452835100000004528341545820154528211000000045281010000000452803154592586452790799000045277633101034527753000000045277315460273745276615445238';
  const FIVE = FIVE_BOOK;

  it('reproduces both published vectors: the venue worked example (3310070434) and the contract five-level book (1396696505)', () => {
    expect(WORKED).toHaveLength(281);
    expect(crc32(WORKED)).toBe(3310070434);
    expect(zlibCrc32(WORKED) >>> 0).toBe(3310070434);
    expect(bookChecksum(FIVE.asks, FIVE.bids)).toBe(1396696505);
    expect(independentBookChecksum(FIVE.asks, FIVE.bids)).toBe(1396696505);
    // The concatenation itself, asks from the lowest price then bids from the highest.
    const text = [...FIVE.asks, ...[...FIVE.bids]].map(([p, q]) => checksumPart(p) + checksumPart(q)).join('');
    expect(text).toBe('62710593111634627106500000006271101200000006271041000000627091200000000');
    // The strip rules the venue's SDK test pins (section 8.2).
    expect(['45285.21000000', '0.00159953', '0', '0.0', '0.000123'].map(checksumPart)).toEqual(['4528521000000', '159953', '', '', '123']);
    // Order matters: the same levels given in another order still check to the same value, and a wrong side order does not.
    expect(bookChecksum([...FIVE.asks].reverse(), [...FIVE.bids].reverse())).toBe(1396696505);
    expect(bookChecksum(FIVE.bids, FIVE.asks)).not.toBe(1396696505);
  });

  it('agrees with node:zlib and with the independent ordering and concatenation on generated books', () => {
    let seed = 20260925;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const lexeme = (whole: number, decimals: number): string => (decimals === 0 ? String(whole) : `${whole}.${String(next(10 ** Math.min(decimals, 6))).padStart(decimals, '0')}`);
    for (let round = 0; round < 400; round++) {
      const side = (): Level[] => {
        const seen = new Set<string>();
        const out: Level[] = [];
        for (let k = next(16); k > 0; k--) {
          const price = lexeme(60000 + next(5000), 1 + next(3));
          if (seen.has(canonicalDecimal(price))) continue;
          seen.add(canonicalDecimal(price));
          out.push([price, next(4) === 0 ? lexeme(next(20), 0) : lexeme(next(3), 1 + next(8))]);
        }
        return out.filter(([, q]) => Number(q) !== 0);
      };
      const asks = side();
      const bids = side();
      expect(bookChecksum(asks, bids), JSON.stringify({ asks, bids })).toBe(independentBookChecksum(asks, bids));
      const text = asks.map(([p, q]) => p + q).join('|');
      expect(crc32(text)).toBe(zlibCrc32(text) >>> 0);
    }
  });

  it('writes tape book frames that verify as section 8.2 replays them, and the replay catches a wrong one', () => {
    const t = new Tape();
    const a = t.subscribedSocket();
    const deep: Level[] = Array.from({ length: 12 }, (_, k) => [`6272${k}.5`, `0.${String(k + 1).padStart(8, '0')}`]);
    const moves = [
      t.book('update', 'BTC/USD', { asks: deep, bids: [['62709.9', '1.00000000']] }),
      t.book('update', 'BTC/USD', { asks: [['62720.5', '0.00000000']], bids: [['62709.9', '0.0']] }),
      t.book('update', 'BTC/USD', { asks: [['62711.0', '2.50']], bids: [['62700.0', '3']] }),
    ];
    const foreign = t.book('update', 'ETH/USD');
    const wrong = t.book('update', 'BTC/USD', { corrupt: true });
    const unsynced = t.book();
    const snapshot = t.book('snapshot');
    const after = t.book();
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const replay = replayBookChecksums(records);
    expect(replay.verified).toEqual([a.update - 1, a.update, ...moves, snapshot, after]);
    // The corrupted update fails; the update after it is not verified until the next snapshot; the other pair's frame
    // is never verified (section 8.2, steps 2 and 3; R6).
    expect(replay.failed).toEqual([wrong]);
    expect(replay.updates).not.toContain(unsynced);
    expect([...replay.verified, ...replay.failed]).not.toContain(foreign);
  });
});

describe('vectors whose books take section 8.2 beyond one book state (handoff A7(r))', () => {
  it('takes only the ten best levels of each side: a twelve-level book gives the CRC32 of its hand-written top-ten string', () => {
    expect(DEEP_BOOK_TOP10).toHaveLength(270);
    expect(zlibCrc32(DEEP_BOOK_TOP10) >>> 0).toBe(2975579563);
    expect(crc32(DEEP_BOOK_TOP10)).toBe(2975579563);
    expect(bookChecksum(DEEP_BOOK.asks, DEEP_BOOK.bids)).toBe(2975579563);
    expect(independentBookChecksum([...DEEP_BOOK.asks].reverse(), [...DEEP_BOOK.bids].reverse())).toBe(2975579563);
  });

  it('carries a book deeper than ten levels: a change beyond the tenth level keeps the checksum until a delete brings it into the top ten', () => {
    const t = new Tape();
    t.subscribedSocket();
    const deep = t.book('snapshot', 'BTC/USD', DEEP_BOOK);
    const beyond = t.book('update', 'BTC/USD', { bids: [['62709.3', '7.00000000']], asks: [['62711.6', '4.50000000']] });
    const enters = t.book('update', 'BTC/USD', { bids: [], asks: [['62710.5', '0.00000000']] });
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toBeNull();
    expect([deep, beyond, enters].map((i) => frameChecksum(records[i]!))).toEqual([2975579563, 2975579563, 1703851086]);
    const replay = replayBookChecksums(records);
    expect(replay.failed).toEqual([]);
    expect(replay.verified).toEqual(expect.arrayContaining([deep, beyond, enters]));
  });

  it('starts each socket from no book: an update before a reconnection\'s snapshot is not verified against the last socket\'s book', () => {
    const t = new Tape();
    t.subscribedSocket();
    t.book('snapshot', 'BTC/USD', DEEP_BOOK);
    t.close('liveness_timeout');
    t.open();
    const ids = (['book', 'trade', 'instrument'] as Channel[]).map((c) => [c, t.sub(c)] as const);
    for (const [c, id] of ids) t.ack(id, c, { timed: true });
    t.instrument();
    const early = t.book('update', 'BTC/USD', { bids: [['62710.4', '0.25000000']], asks: [] });
    const snapshot = t.book('snapshot', 'BTC/USD', FIVE_BOOK);
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    const replay = replayBookChecksums(records);
    expect(replay.failed).toEqual([]);
    expect(replay.updates).not.toContain(early);
    // The tape starts the new socket from no book, as a normalizer must: this update's checksum covers its own level only
    // (a normalizer that kept the last socket's book would compute 2975579563 and fail it, were it verified).
    expect(frameChecksum(records[early]!)).toBe(3267759264);
    expect(replay.verified).toContain(snapshot);
    expect(frameChecksum(records[snapshot]!)).toBe(1396696505);
    const report = analyzeCapture(records, BTC);
    expect(report.refused).toBeNull();
    expect(report.sockets.map((s) => s.refused)).toEqual([null, null]);
  });

  it('carries the contract five-level book after a snapshot that replaces a populated book, then a delete and a re-add', () => {
    const t = new Tape();
    t.subscribedSocket();
    // A level the next snapshot does not hold: kept by a replay that did not reset its book, it would fail the snapshot.
    t.book('update', 'BTC/USD', { bids: [], asks: [['62712.0', '0.10000000']] });
    const five = t.book('snapshot', 'BTC/USD', FIVE_BOOK);
    const removed = t.book('update', 'BTC/USD', { bids: [['62709.1', '0.00000000']], asks: [] });
    const readded = t.book('update', 'BTC/USD', { bids: [['62709.1', '1.00000000']], asks: [] });
    t.close('capture_end');
    const records = t.end();
    schemaValid(records);
    expect(analyzeCapture(records, BTC).refused).toBeNull();
    const values = [five, removed, readded].map((i) => frameChecksum(records[i]!));
    expect(values[0]).toBe(1396696505);
    expect(new Set(values).size).toBe(3);
    const replay = replayBookChecksums(records);
    expect(replay.failed).toEqual([]);
    expect(replay.verified).toEqual(expect.arrayContaining([five, removed, readded]));
  });
});

describe('the export self-test hook', () => {
  // Fails on purpose only when the export self-test asks for it, to show that a run with a failing test exports nothing.
  it.runIf(process.env.CAPTURE_VECTORS_SELFTEST_FAIL === '1')('export self-test: a failing test', () => {
    expect('this test fails on purpose').toBe('');
  });
});

describe('the vector streams, for PR-1 (handoff A7(r))', () => {
  const CLEAN: RunOutcome = { failed: [], skipped: [] };
  const sample = (): typeof judged => {
    const t = new Tape();
    t.subscribedSocket();
    t.close('capture_end');
    return [{ test: 'sample', instrument: BTC, records: t.end() }];
  };

  it('refuses an empty value, a run that failed or skipped a test, a bad checksum and a target inside the repository, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-vectors-'));
    try {
      for (const empty of ['', '   ']) expect(() => exportVectors(empty, sample(), CLEAN), JSON.stringify(empty)).toThrow(/set but empty/);
      expect(() => exportVectors(join(dir, 'a'), sample(), { failed: ['some test'], skipped: [] })).toThrow(/test\(s\) failed/);
      expect(() => exportVectors(join(dir, 'c'), sample(), { failed: [], skipped: ['some test'] })).toThrow(/did not run/);
      const bad = sample();
      const t = new Tape();
      t.subscribedSocket();
      t.book('update', 'BTC/USD', { corrupt: true });
      t.close('capture_end');
      bad.push({ test: 'corrupt', instrument: BTC, records: t.end() });
      expect(() => exportVectors(join(dir, 'b'), bad, CLEAN)).toThrow(/section 8.2 checksum fails/);
      // Each stream is replayed for its own selected instrument, not only for BTC/USD.
      const other = new Tape();
      other.subscribedSocket();
      other.book('snapshot', 'ETH/USD', { bids: [['2500.10', '1.00000000']], asks: [['2500.20', '2.00000000']], corrupt: true });
      other.close('capture_end');
      expect(() => exportVectors(join(dir, 'd'), [{ test: 'another pair', instrument: { ...BTC, symbol: 'ETH/USD' }, records: other.end() }], CLEAN)).toThrow(/section 8.2 checksum fails/);
      expect(['a', 'b', 'c', 'd'].some((d) => existsSync(join(dir, d)))).toBe(false);
      const link = join(dir, 'link-to-repo');
      symlinkSync(repoRootPath, link);
      const dangling = join(dir, 'dangling');
      symlinkSync(join(repoRootPath, 'vectors-dangling-target'), dangling);
      const inside = [
        join(repoRootPath, 'out', 'vectors-in'),
        join(repoRootPath, '..vectors'),
        join('out', 'vectors-relative'),
        join(link, 'vectors-via-link'),
      ];
      for (const target of inside) expect(() => exportVectors(target, sample(), CLEAN), target).toThrow(/must be outside the repository/);
      // A '..' segment is refused before anything is resolved: after a link, path.resolve and the file system would read it
      // differently (a link to the repository's tests directory, then '..', names the repository itself).
      const testsLink = join(dir, 'link-to-tests');
      symlinkSync(join(repoRootPath, 'tests'), testsLink);
      mkdirSync(join(dir, 'victim-dir'));
      writeFileSync(join(dir, 'victim-dir', 'keep.txt'), 'x');
      for (const target of [`${repoRootPath}${sep}tests${sep}..${sep}out${sep}vectors-dots`, `${testsLink}${sep}..${sep}victim-dir`, `${testsLink}${sep}..${sep}leak${sep}x`, `a${sep}..${sep}..${sep}vectors-up`, `${dir}${sep}..`]) {
        expect(() => exportVectors(target, sample(), CLEAN), target).toThrow(/must not contain a '\.\.' segment/);
      }
      expect(readdirSync(join(dir, 'victim-dir'))).toEqual(['keep.txt']);
      // A dangling link on the path, as the target or above it, is refused whatever it points at.
      for (const target of [dangling, join(dangling, 'sub')]) expect(() => exportVectors(target, sample(), CLEAN), target).toThrow(/cannot be resolved/);
      for (const leaked of ['out/vectors-in', '..vectors', 'out/vectors-dots', 'out/vectors-relative', 'vectors-via-link', 'vectors-dangling-target', 'victim-dir', 'leak', 'a']) {
        expect(existsSync(join(repoRootPath, leaked)), leaked).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes only into a new or empty real directory, creating each file exclusively: a planted link or hard link is never written through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-vectors-'));
    try {
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'unchanged\n');
      const planted = join(dir, 'planted-link');
      mkdirSync(planted);
      symlinkSync(victim, join(planted, '000.jsonl'));
      const hard = join(dir, 'planted-hardlink');
      mkdirSync(hard);
      linkSync(victim, join(hard, '000.jsonl'));
      const full = join(dir, 'not-empty');
      mkdirSync(full);
      writeFileSync(join(full, 'other.txt'), 'x');
      const fileTarget = join(dir, 'a-file');
      writeFileSync(fileTarget, 'x');
      const dirLink = join(dir, 'dir-link');
      mkdirSync(join(dir, 'real-empty'));
      symlinkSync(join(dir, 'real-empty'), dirLink);
      for (const target of [planted, hard, full, fileTarget, dirLink, `${dirLink}${sep}`, `${dirLink}${sep}.`]) expect(() => exportVectors(target, sample(), CLEAN), target).toThrow(/new directory or an existing empty one/);
      expect(readFileSync(victim, 'utf8')).toBe('unchanged\n');
      expect(readdirSync(join(dir, 'real-empty'))).toEqual([]);
      // Accepted: a new directory, and an existing empty one; every file is a regular file with a single link.
      for (const target of [join(dir, 'new', 'streams'), join(dir, 'real-empty')]) {
        exportVectors(target, sample(), CLEAN);
        expect(readdirSync(target).sort()).toEqual(['000.jsonl', 'vectors.json']);
        for (const f of ['000.jsonl', 'vectors.json']) {
          const st = lstatSync(join(target, f));
          expect(st.isFile() && st.nlink === 1, f).toBe(true);
        }
        // A second export into the same directory is refused: it is no longer empty.
        expect(() => exportVectors(target, sample(), CLEAN)).toThrow(/new directory or an existing empty one/);
      }
      expect(statSync(victim).nlink).toBe(2);
      expect(readFileSync(victim, 'utf8')).toBe('unchanged\n');
      // The second layer on its own: each file is created exclusively, so a link or hard link that appears in the
      // directory after the emptiness check is not written through either.
      for (const path of [join(planted, '000.jsonl'), join(hard, '000.jsonl')]) expect(() => writeNew(path, 'raw'), path).toThrow(/EEXIST/);
      expect(readFileSync(victim, 'utf8')).toBe('unchanged\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no vector when a write fails: it removes the files the export wrote, and the directories it made', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-vectors-'));
    try {
      // The third stream cannot be serialized (a BigInt), so its write fails after two files were written.
      const streams = [...sample(), ...sample(), { test: 'unwritable', instrument: BTC, records: [{ type: 'note', recvWallMs: 1n } as unknown as RawRecord] }];
      const fresh = join(dir, 'fresh', 'nested', 'streams');
      expect(() => exportVectors(fresh, streams, CLEAN)).toThrow(/BigInt/);
      expect(readdirSync(dir)).toEqual([]);
      const empty = join(dir, 'empty');
      mkdirSync(empty);
      expect(() => exportVectors(empty, streams, CLEAN)).toThrow(/BigInt/);
      expect(readdirSync(empty)).toEqual([]);
      expect(readdirSync(dir)).toEqual(['empty']);
      const system = exportIo.writeSync;
      const three = (): typeof judged => [...sample(), ...sample(), ...sample()];
      try {
        // A write that fails after its file exists (a full disk, say) leaves no file either, and its error is the one
        // thrown; so does a write that stores nothing.
        let calls = 0;
        exportIo.writeSync = (fd, buffer, offset, length) => {
          if (++calls === 2) {
            system(fd, buffer, offset, Math.min(length, 10));
            throw new Error('ENOSPC: no space left on device (simulated)');
          }
          return system(fd, buffer, offset, length);
        };
        for (const target of [join(dir, 'full', 'streams'), empty]) {
          calls = 0;
          expect(() => exportVectors(target, three(), CLEAN), target).toThrow(/ENOSPC/);
        }
        exportIo.writeSync = (fd, buffer, offset, length) => (++calls === 2 ? 0 : system(fd, buffer, offset, length));
        calls = 0;
        expect(() => exportVectors(join(dir, 'stuck', 'streams'), three(), CLEAN)).toThrow(/stored nothing/);
        // A file another process puts in the directory meanwhile is left alone, and the export still reports its own error.
        const raced = join(dir, 'raced', 'streams');
        exportIo.writeSync = (fd, buffer, offset, length) => {
          if (++calls === 2) {
            writeFileSync(join(raced, 'foreign.txt'), 'theirs');
            throw new Error('ENOSPC: no space left on device (simulated)');
          }
          return system(fd, buffer, offset, length);
        };
        calls = 0;
        expect(() => exportVectors(raced, three(), CLEAN)).toThrow(/^ENOSPC.*; removing what the export wrote also failed, so it may be left: ENOTEMPTY/);
        expect(readdirSync(raced)).toEqual(['foreign.txt']);
        rmSync(join(dir, 'raced'), { recursive: true, force: true });
        expect(readdirSync(empty)).toEqual([]);
        expect(readdirSync(dir)).toEqual(['empty']);
        // Writes that each store only a few bytes still write every byte: the files read back whole.
        exportIo.writeSync = (fd, buffer, offset, length) => system(fd, buffer, offset, Math.min(length, 7));
        const short = join(dir, 'short');
        const streams = three();
        exportVectors(short, streams, CLEAN);
        expect(readFileSync(join(short, '002.jsonl'), 'utf8')).toBe(streams[2]!.records.map((r) => JSON.stringify(r) + '\n').join(''));
        expect((JSON.parse(readFileSync(join(short, 'vectors.json'), 'utf8')) as unknown[]).length).toBe(3);
        // A close that fails is an error too: after a failed write the write's error is reported, after good writes the
        // close's, and either way nothing is left.
        exportIo.writeSync = system;
        const close = exportIo.closeSync;
        try {
          exportIo.closeSync = (fd) => {
            close(fd);
            throw new Error('EIO: i/o error, close (simulated)');
          };
          expect(() => exportVectors(join(dir, 'closed', 'streams'), three(), CLEAN)).toThrow(/EIO: i\/o error, close/);
          exportIo.writeSync = () => {
            throw new Error('ENOSPC: no space left on device (simulated)');
          };
          expect(() => exportVectors(join(dir, 'both', 'streams'), three(), CLEAN)).toThrow(/^ENOSPC/);
        } finally {
          exportIo.closeSync = close;
        }
        expect(readdirSync(dir).sort()).toEqual(['empty', 'short']);
      } finally {
        exportIo.writeSync = system;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads what a run did from its tasks: a failed test, and a test it did not run unless only the export uses it', () => {
    const test = (name: string, mode: string, state?: string): unknown => ({ type: 'test', name, mode, result: state === undefined ? undefined : { state } });
    const [harness] = [...EXPORT_HARNESS];
    const file = {
      type: 'suite',
      tasks: [
        test('passes', 'run', 'pass'),
        { type: 'suite', tasks: [test('fails', 'run', 'fail'), test('filtered out', 'skip'), test('todo', 'todo')] },
        test(harness!, 'skip'),
        test('never ran', 'run'),
        test(harness!, 'run', 'fail'),
        test(harness!, 'run'),
      ],
    } as unknown as RunnerTask;
    // A harness test is excused only when it is skipped: one that failed or never ran counts like any other.
    expect(runOutcome(file)).toEqual({ failed: ['fails', harness], skipped: ['filtered out', 'todo', 'never ran', harness] });
  });

  it.skipIf(process.env.CAPTURE_VECTORS_OUT !== undefined)('writes every stream the reference judges when CAPTURE_VECTORS_OUT names a directory outside the repository, end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-vectors-'));
    try {
      const out = join(dir, 'streams');
      const vitest = join(repoRootPath, 'node_modules', '.bin', 'vitest');
      /** Runs this file, whole or filtered, with CAPTURE_VECTORS_OUT set: '' when it passes, else what it printed. */
      const run = (target: string, filter?: string, env: Record<string, string> = {}): string => {
        try {
          execFileSync(vitest, ['run', 'tests/capture-structure.test.ts', ...(filter === undefined ? [] : ['-t', filter])], { cwd: repoRootPath, env: { ...process.env, ...env, CAPTURE_VECTORS_OUT: target }, stdio: 'pipe' });
          return '';
        } catch (e) {
          const { stdout, stderr } = e as { stdout?: Buffer; stderr?: Buffer };
          return `${stdout?.toString() ?? ''}${stderr?.toString() ?? ''}` || 'the run failed';
        }
      };
      expect(run(out)).toBe('');
      const index = JSON.parse(readFileSync(join(out, 'vectors.json'), 'utf8')) as { file: string; test: string; instrument: SelectedInstrument }[];
      expect(readdirSync(out).sort()).toEqual([...index.map((v) => v.file), 'vectors.json'].sort());
      const streams = index.map((v, k) => {
        expect(v.file).toBe(`${String(k).padStart(3, '0')}.jsonl`);
        const text = readFileSync(join(out, v.file), 'utf8');
        const records = text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as RawRecord);
        expect(records.map((r) => JSON.stringify(r) + '\n').join('')).toBe(text);
        schemaValid(records);
        return { test: v.test, instrument: v.instrument, records };
      });
      // Every stream, read back from disk, verifies as section 8.2 replays it, and as many reach segments and clocks as
      // the vectors give the reference in this process.
      expectReach(streams, 'the exported streams');
      const refused = streams.find((s) => /refuses a second manifest_start/.test(s.test))!;
      expect(analyzeCaptureReference(refused.records, BTC).refused).toMatchObject({ rule: 'R10', reason: expect.stringMatching(/a second manifest_start/) });
      // The clock vector: a normalizer opens a segment at the first verified update inside the socket's window, and that
      // segment owns three samples.
      const clock = streams.find((s) => /computes the estimate exactly/.test(s.test))!;
      const replay = replayBookChecksums(clock.records);
      expect(replay.failed).toEqual([]);
      const report = analyzeCaptureReference(clock.records, BTC);
      const socket = report.sockets[0]!;
      const [from, to] = socket.window!;
      const first = replay.verified.find((i) => replay.updates.includes(i) && i >= from && i <= to)!;
      const last = Math.max(...replay.verified.filter((i) => i <= to));
      expect(clockEstimate(clock.records, ownedClockSamples(clock.records, socket, first, last))).toEqual({ samples: 3, medianMs: '45.025', medianRttMs: '29.950', maxAbsMs: '55.025', resolutionMs: 1, source: 'ws_method_response' });
      // Refused end to end, each for its own reason, writing nothing: a filtered run, a run in which a test failed, an
      // empty value, and a directory inside the repository, also through a link.
      const filtered = join(dir, 'filtered');
      expect(run(filtered, 'refuses a second manifest_start')).toMatch(/test\(s\) did not run/);
      const failing = join(dir, 'after-a-failure');
      // A failure is refused before a filter is: this filtered run fails the self-test, and that is the reason given.
      expect(run(failing, 'refuses a second manifest_start|export self-test: a failing test', { CAPTURE_VECTORS_SELFTEST_FAIL: '1' })).toMatch(/1 test\(s\) failed \(export self-test: a failing test\)/);
      expect(run('', 'refuses a second manifest_start')).toMatch(/set but empty/);
      const link = join(dir, 'link-to-repo');
      symlinkSync(repoRootPath, link);
      for (const inside of [join(repoRootPath, 'out', 'vectors'), join(repoRootPath, '..vectors'), join(link, 'vectors-via-link')]) {
        expect(run(inside, 'refuses a second manifest_start'), inside).toMatch(/must be outside the repository/);
      }
      expect(existsSync(filtered) || existsSync(failing)).toBe(false);
      for (const leaked of ['out/vectors', '..vectors', 'vectors-via-link']) expect(existsSync(join(repoRootPath, leaked)), leaked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

// Last in this file, so that it sees every stream the vectors above gave the reference.
describe('every stream the vectors give the reference (handoff A7(r)): valid checksums, and segments and clocks reached', () => {
  it('carries the section 8.2 checksum on every book frame, and reaches segment windows and clock ownership on many streams', () => {
    // A -t filter that selects this test alone leaves it no streams: it needs the vectors above to have run.
    expectReach([...judged], 'run the whole file: this test checks the streams the vectors above built');
  });
});
