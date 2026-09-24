// A10, the repository rule for recorded data (docs/M2_DATA_CONTRACT.md section 6.5, docs/M2_GROK_HANDOFF.md A10).
//
// Fail closed: every tracked file the rule covers must be one of the allowed kinds below, and anything this policy
// cannot classify fails. The rule covers three kinds of path:
//
//   any path under the root's captures/ or normalized/   never allowed, whatever the file (both directories are the
//                                                        default output of the capture and normalize tools and are in
//                                                        .gitignore; a file there enters Git only by force)
//   a name ending in .normalize-report.json              must validate against schemas/normalize-report.v1.schema.json,
//                                                        which is closed (contract section 5.10); its bytes must be
//                                                        exactly its canonical serialization (every object's keys
//                                                        sorted, JSON.stringify with an indent of 2 and one newline);
//                                                        its arrays must be in the contract's order; each fixtureFile
//                                                        must name its own capture and segment; and each rule must
//                                                        carry its own scope and fields, so a duplicated key,
//                                                        whitespace or an order carries nothing
//   a name ending in .jsonl                              must be one of the two allowed fixture kinds:
//
//   synthetic_v1              the engine's version-1 synthetic fixture format: the header has only the documented
//                             version-1 keys, each with its version-1 type, synthetic: true, provenance.source
//                             "synthetic" and the exact synthetic label; the engine's parser accepts the whole file;
//                             every trade's aggressor is buy, sell or unknown; and the engine's serializer reproduces the
//                             file byte for byte, so no line carries a key, value type or byte outside that format.
//   recorded_v2_publishable   a version-2 recorded fixture whose header matches fixture.v2 $defs/header with
//                             synthetic: false, whose rights block is redistribution "permitted" with publication
//                             "sample_permitted" (the schema then requires a non-blank terms URL, check date, checker
//                             and note), whose every following line matches $defs/event, and whose eventCount matches.
//
// Every other .jsonl file fails: a raw capture record on any line, invalid JSON, a line that is not a JSON object, a
// first line that is not a fixture header (unwrapped venue frames, headerless events or objects), a version-1 header
// that is not synthetic, a version-2 synthetic header (the synthetic generator writes version 1), a recorded fixture
// without that rights shape, any other schema version, and an empty file. Names are matched in any letter case. A
// covered path that is a symbolic link or a submodule entry fails in both scopes, whatever it points to.
//
// The check is structural. It cannot see whether a rights note's attestation exists or clears its scope (the owner
// verifies that by hand); whether a file declared synthetic is in fact synthetic (recorded observations re-encoded in
// the version-1 format and labelled synthetic pass kind synthetic_v1); a venue payload pasted into a string value of
// either fixture kind, or into an open object of a recorded fixture; a recorded value encoded into a normalize report's
// constrained values (an integer in any integer field, the number of entries in an array, the choice among the
// enumerated codes a value may take, or bytes hex-encoded into a hash, UUID, commit or version string); or any file whose name matches none of the three kinds (.ndjson, .json other than a normalize report,
// compressed files). Review remains the control for those.
//
// Two scopes use the same rule: trackedHygieneFiles lists the tree under test (the files tracked at this moment), and
// historyViolations scans every commit of a commit range, so a file added and deleted again inside the range is still
// found. Both detect; neither prevents anything that has already been pushed (contract section 6.5).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parseFixture, serializeFixture } from '../src/market/events.js';

const addFormats = addFormatsModule.default;
export const repoRoot = new URL('../', import.meta.url);
/** The repository root as a file-system path. */
export const repoRootPath = fileURLToPath(repoRoot);
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRootPath, path), 'utf8'));

/** Strict UTF-8: a byte sequence that is not UTF-8 throws instead of becoming U+FFFD, and a leading BOM is kept. */
const decodeStrict = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

/**
 * Reads a repository-relative path literally, as a path (never as a URL, where `?`, `#` and `%` would change it), and
 * decodes it as strict UTF-8: a byte sequence that is not UTF-8 throws instead of becoming U+FFFD, and a leading BOM is
 * kept (so JSON.parse rejects it). A text that decodes, re-encodes to the same bytes, which makes the synthetic kind's
 * text comparison a byte-for-byte one.
 */
export const readRepoFile = (path: string, root: string = repoRootPath): string => decodeStrict(readFileSync(join(root, path)));

export type Verdict =
  | { ok: true; kind: 'synthetic_v1' | 'recorded_v2_publishable' | 'normalize_report_v1' }
  | { ok: false; reason: string };
/** The verdict type of the .jsonl classifier (kept for its original name). */
export type JsonlVerdict = Verdict;

const captureSchema = readJson('schemas/capture-record.v1.schema.json');
const fixtureSchema = readJson('schemas/fixture.v2.schema.json');
const reportSchema = readJson('schemas/normalize-report.v1.schema.json');
const CAPTURE_RECORD_TYPES = new Set<string>(captureSchema.properties.type.enum);

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv, ['date', 'date-time', 'uuid']);
ajv.addSchema(fixtureSchema);
ajv.addSchema(reportSchema);
const schemaRef = (ref: string): ValidateFunction => {
  const v = ajv.getSchema(ref);
  if (!v) throw new Error(`schema definition not found: ${ref}`);
  return v;
};
const v2Header = schemaRef(`${fixtureSchema.$id as string}#/$defs/header`);
const v2Event = schemaRef(`${fixtureSchema.$id as string}#/$defs/event`);
const normalizeReport = schemaRef(reportSchema.$id as string);

type Check = (v: unknown) => boolean;
const str: Check = (v) => typeof v === 'string';
const int: Check = (v) => Number.isSafeInteger(v);
const optional = (check: Check): Check => (v) => v === undefined || check(v);

/** The version-1 header of docs/EVENT_SCHEMA.md, key by key with the type each value must have. */
const V1_HEADER: Record<string, Check> = {
  type: str, schemaVersion: int, symbol: str, venue: str, priceScale: int, qtyScale: int, tickSize: str, lotSize: str,
  startTime: int, endTime: int, eventCount: int, synthetic: (v) => v === true, syntheticLabel: str,
  provenance: (v) => isObject(v),
};
/** The keys the synthetic generator writes under provenance, with their types. */
const V1_SYNTHETIC_PROVENANCE: Record<string, Check> = {
  source: str, description: str, generator: optional(str), generatorVersion: optional(str), seed: optional(int),
  timeBasis: (v) => isObject(v),
};
const TIME_BASIS: Record<string, Check> = { obsTime: str, marketTime: str };
const AGGRESSORS = new Set(['buy', 'sell', 'unknown']);

const fail = (reason: string): Verdict => ({ ok: false, reason });
const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const firstError = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? []).filter((e) => e.keyword !== 'if').map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)[0] ?? 'invalid';

/** The first key of `obj` that `shape` does not declare, or whose value has the wrong type; also any missing required key. */
function outsideShape(obj: Record<string, unknown>, shape: Record<string, Check>, at: string): string | undefined {
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(shape, key)) return `${at}${key} is not a version-1 key`;
  }
  for (const [key, check] of Object.entries(shape)) {
    if (!check(obj[key])) return `${at}${key} is missing or has a type outside the version-1 format`;
  }
  return undefined;
}

/** A raw capture record (schemas/capture-record.v1.schema.json): a record type of that schema, or both receive clocks. */
function isRawCaptureRecord(v: Record<string, any>): boolean {
  return (typeof v.type === 'string' && CAPTURE_RECORD_TYPES.has(v.type)) || ('recvWallMs' in v && 'recvMonoNs' in v);
}

export function classifyJsonl(text: string): Verdict {
  // Blank lines are skipped, as the engine's parser skips them; everything else must be a JSON object.
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return fail('no non-blank line: not an allowed fixture');
  const values: Record<string, any>[] = [];
  for (const [i, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return fail(`non-blank line ${i + 1} is not valid JSON`);
    }
    if (!isObject(value)) return fail(`non-blank line ${i + 1} is not a JSON object`);
    if (isRawCaptureRecord(value)) return fail(`non-blank line ${i + 1} is a raw capture record`);
    values.push(value);
  }
  const header = values[0]!;
  if (header.type !== 'header') return fail('the first non-blank line is not a fixture header (unclassified JSONL)');
  if (header.schemaVersion === 1) return classifySyntheticV1(text, header);
  if (header.schemaVersion === 2) return classifyRecordedV2(header, values.slice(1));
  return fail(`fixture schemaVersion ${JSON.stringify(header.schemaVersion)} is not an allowed format`);
}

function classifySyntheticV1(text: string, header: Record<string, any>): Verdict {
  if (header.synthetic !== true) {
    return fail('a version-1 header must be synthetic: recorded data requires schema version 2 with a rights block');
  }
  if (!isObject(header.provenance) || header.provenance.source !== 'synthetic') {
    return fail('a synthetic header must have provenance.source "synthetic"');
  }
  if (!isObject(header.provenance.timeBasis)) {
    return fail('a synthetic header needs provenance.timeBasis as an object with obsTime and marketTime');
  }
  const outside =
    outsideShape(header, V1_HEADER, '') ??
    outsideShape(header.provenance, V1_SYNTHETIC_PROVENANCE, 'provenance.') ??
    outsideShape(header.provenance.timeBasis, TIME_BASIS, 'provenance.timeBasis.');
  if (outside !== undefined) return fail(`the synthetic header is outside the version-1 format: ${outside}`);
  let reserialized: string;
  try {
    const fixture = parseFixture(text);
    const odd = fixture.events.findIndex((e) => e.type === 'trade' && !AGGRESSORS.has(e.aggressor as unknown as string));
    if (odd >= 0) return fail(`event ${odd + 1} is a trade whose aggressor is not buy, sell or unknown`);
    reserialized = serializeFixture(fixture);
  } catch (e) {
    return fail(`the engine's fixture parser rejects it: ${(e as Error).message}`);
  }
  if (reserialized !== text) {
    return fail("the engine's serializer does not reproduce it byte for byte: it carries content the engine does not write");
  }
  return { ok: true, kind: 'synthetic_v1' };
}

function classifyRecordedV2(header: Record<string, any>, events: Record<string, any>[]): Verdict {
  if (!v2Header(header)) return fail(`the version-2 header does not match fixture.v2 $defs/header: ${firstError(v2Header.errors)}`);
  if (header.synthetic !== false) {
    return fail('a version-2 synthetic fixture is not an allowed format (the synthetic generator writes version 1)');
  }
  const rights = header.provenance.rights as Record<string, unknown>;
  if (rights.redistribution !== 'permitted' || rights.publication !== 'sample_permitted') {
    return fail('a recorded fixture enters the repository only with redistribution "permitted" and publication "sample_permitted"');
  }
  for (const [i, event] of events.entries()) {
    if (!v2Event(event)) return fail(`event ${i + 1} does not match fixture.v2 $defs/event: ${firstError(v2Event.errors)}`);
  }
  if (header.eventCount !== events.length) {
    return fail(`the header's eventCount ${String(header.eventCount)} does not match the ${events.length} events present`);
  }
  return { ok: true, kind: 'recorded_v2_publishable' };
}

/** A copy of a JSON value with every object's keys in ascending order (report keys are ASCII). */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
};

/** The canonical bytes of a normalize report (contract section 5.10): sorted keys, two-space JSON and one final newline. */
export const canonicalReport = (value: unknown): string => JSON.stringify(sortKeys(value), null, 2) + '\n';

type RecordRef = { fileIndex: number; record: number } | null;
const REPORT_RULES: (string | null)[] = reportSchema.$defs.rule.enum;
const REPORT_FIELDS: (string | null)[] = reportSchema.$defs.rejection.properties.field.enum;
/** Each rule's one scope and the field names it may carry (contract section 5.10). */
const RULE_SHAPES: Record<string, { scope: string; fields: (string | null)[] }> = {
  R1: { scope: 'capture', fields: ['manifestEnd', 'captureFormatVersion', 'capturer', 'recvWallMs', 'recvMonoNs'] },
  R1b: { scope: 'capture', fields: [null] },
  R2: { scope: 'segment', fields: [null] },
  R2b: { scope: 'segment', fields: [null] },
  R4: { scope: 'item', fields: ['price', 'size', null] },
  R5: { scope: 'capture', fields: ['priceDecimals', 'qtyDecimals', 'priceIncrement', 'instrumentSpec', 'pair', 'status'] },
  R6: { scope: 'segment', fields: [null] },
  R7: { scope: 'segment', fields: [null] },
  R8: { scope: 'capture', fields: ['rights'] },
  R9: { scope: 'socket', fields: [null] },
  R10: { scope: 'capture', fields: [null] },
};
const refKey = (ref: RecordRef): number[] => (ref === null ? [-1, -1] : [ref.fileIndex, ref.record]);
const compareKeys = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1);
  return 0;
};
const strictlyAscending = (keys: number[][]): boolean => keys.every((k, i) => i === 0 || compareKeys(keys[i - 1]!, k) < 0);

/**
 * The first way a schema-valid report breaks the order, naming and pairing rules of contract section 5.10, or undefined:
 * raw files and segments numbered from 0 in order, cuts and each dropped entry's records in strictly ascending
 * raw-record order (so no record twice, and no more records than the count), rejections strictly ascending by (at,
 * segmentIndex, rule, field), supersedes by segmentIndex, each fixtureFile naming its own capture and segment, each rule
 * with its one scope and its own fields (R3, a cut, is never a rejection), a segment rejection naming the rule its
 * segment names, and too_short exactly under R7.
 */
function reportOrderViolation(r: Record<string, any>): string | undefined {
  if (!r.rawFiles.every((f: any, i: number) => f.fileIndex === i)) return 'rawFiles not numbered 0, 1, 2, ... in order';
  if (!r.segments.every((s: any, i: number) => s.segmentIndex === i)) return 'segments not numbered 0, 1, 2, ... in order';
  const misnamed = r.segments.find((s: any) => s.fixtureFile !== null && s.fixtureFile !== `${r.captureId}-seg${s.segmentIndex}.jsonl`);
  if (misnamed) return `segment ${misnamed.segmentIndex}'s fixtureFile does not name its own capture and segment`;
  if (!strictlyAscending(r.cuts.map((c: any) => refKey(c.at)))) return 'cuts not in strictly ascending raw-record order';
  for (const [key, entry] of Object.entries<any>(r.dropped)) {
    if (!strictlyAscending(entry.records.map(refKey))) return `dropped.${key}.records not in strictly ascending raw-record order`;
    if (entry.records.length > entry.count) return `dropped.${key} lists more records than its count`;
  }
  const rejectionKey = (j: any): number[] => [...refKey(j.at), j.segmentIndex ?? -1, REPORT_RULES.indexOf(j.rule), REPORT_FIELDS.indexOf(j.field)];
  if (!strictlyAscending(r.rejections.map(rejectionKey))) return 'rejections not in strictly ascending order of (at, segmentIndex, rule, field)';
  if (r.supersedes !== undefined && !strictlyAscending(r.supersedes.map((s: any) => [s.segmentIndex]))) return 'supersedes not in strictly ascending segmentIndex order';
  for (const j of r.rejections) {
    if (j.rule === 'R3') return 'rule R3, a cut, listed as a rejection (cuts are reported only in cuts)';
    const allowed = RULE_SHAPES[j.rule as string]!;
    if (j.scope !== allowed.scope) return `rule ${j.rule} with scope ${j.scope}, not ${allowed.scope}`;
    if (!allowed.fields.includes(j.field)) return `rule ${j.rule} naming field ${String(j.field)}`;
    if (j.scope === 'segment' ? j.segmentIndex === null : j.scope !== 'item' && j.segmentIndex !== null) return `rule ${j.rule} with scope ${j.scope} and segmentIndex ${String(j.segmentIndex)}`;
    if (j.scope === 'segment' && r.segments[j.segmentIndex]?.rule !== j.rule) return `rule ${j.rule} for segment ${j.segmentIndex}, which that segment does not name`;
  }
  for (const s of r.segments) {
    if (s.status === 'too_short' && s.rule !== 'R7') return `segment ${s.segmentIndex} too_short under ${s.rule}, not R7`;
    if (s.status === 'refused' && s.rule === 'R7') return `segment ${s.segmentIndex} refused under R7, which marks it too_short`;
  }
  return undefined;
}

/**
 * A normalize report: one JSON document that validates against the closed schemas/normalize-report.v1.schema.json,
 * whose text is exactly its canonical serialization, and whose arrays and fixture file names follow contract section
 * 5.10. Parsing keeps only the last of duplicated keys, so without the byte check an earlier duplicate (or the layout or
 * key order itself) could carry text the schema never sees.
 */
export function classifyNormalizeReport(text: string): Verdict {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('a normalize report that is not valid JSON');
  }
  if (!normalizeReport(value)) {
    return fail(`the normalize report does not match schemas/normalize-report.v1.schema.json: ${firstError(normalizeReport.errors)}`);
  }
  if (text !== canonicalReport(value)) {
    return fail('a normalize report whose bytes are not its canonical serialization (a duplicated key, another layout or another key order)');
  }
  const disorder = reportOrderViolation(value as Record<string, any>);
  if (disorder !== undefined) return fail(`a normalize report out of its canonical order: ${disorder}`);
  return { ok: true, kind: 'normalize_report_v1' };
}

export type HygieneKind = 'capture_dir' | 'normalize_report' | 'jsonl';
const CAPTURE_DIR_REASON = 'a file under captures/ or normalized/, which never enter Git, whatever the file';
const SYMLINK_REASON = 'a symbolic link where the rule allows only a regular file';
const SUBMODULE_REASON = 'a submodule entry where the rule allows only a regular file';
const NOT_UTF8_REASON = 'bytes that are not UTF-8';
const MISSING_REASON = 'a tracked path that is missing from the working tree';
const NOT_FILE_REASON = 'a path that is not a regular file where the rule allows only a regular file';

/** Whether git records `path` as a submodule entry (mode 160000) in the index of `root`; a git failure throws. */
const isGitlink = (root: string, path: string): boolean =>
  execFileSync('git', ['ls-files', '-s', '-z', '--', path], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).startsWith('160000 ');

/** Which part of the rule covers a repository-relative path, or undefined when the rule does not cover it. */
export function hygieneKind(path: string): HygieneKind | undefined {
  if (/^(captures|normalized)\//i.test(path)) return 'capture_dir';
  if (/\.normalize-report\.json$/i.test(path)) return 'normalize_report';
  if (/\.jsonl$/i.test(path)) return 'jsonl';
  return undefined;
}

/** The verdict for a path the rule covers, given its decoded content. */
export function classifyTrackedFile(path: string, text: string): Verdict {
  switch (hygieneKind(path)) {
    case 'capture_dir':
      return fail(CAPTURE_DIR_REASON);
    case 'normalize_report':
      return classifyNormalizeReport(text);
    case 'jsonl':
      return classifyJsonl(text);
    default:
      return fail('not a path the repository rule covers');
  }
}

/**
 * The verdict for a covered path of the tree under test, read from `root`: a path under captures/ or normalized/ fails
 * without being read; a submodule entry (in a git checkout, by its index mode; anywhere, a directory) and a symbolic
 * link fail whatever they point to (as they do in history); a missing path or any other non-file fails; bytes that are
 * not UTF-8 fail; and the content is then classified.
 */
export function classifyRepoPath(path: string, root: string = repoRootPath): Verdict {
  if (hygieneKind(path) === 'capture_dir') return fail(CAPTURE_DIR_REASON);
  if (existsSync(join(root, '.git')) && isGitlink(root, path)) return fail(SUBMODULE_REASON);
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (stat === undefined) return fail(MISSING_REASON);
  if (stat.isSymbolicLink()) return fail(SYMLINK_REASON);
  if (stat.isDirectory()) return fail(SUBMODULE_REASON);
  if (!stat.isFile()) return fail(NOT_FILE_REASON);
  let text: string;
  try {
    text = readRepoFile(path, root);
  } catch {
    return fail(NOT_UTF8_REASON);
  }
  return classifyTrackedFile(path, text);
}

/**
 * Directories never scanned by the fallback, relative to the root: git's own, the dependencies, and the demo's and
 * build's output. Everything else is scanned, the ignored capture directories included.
 */
const FALLBACK_SKIP = new Set(['.git', 'node_modules', 'out', 'dist']);

/**
 * Every tracked file under `root` that the rule covers (hygieneKind), as root-relative paths.
 *
 * In a git checkout (a `.git` entry at the root) the list comes from `git ls-files`, and a git failure there throws,
 * failing the test rather than guessing. Where the root has no `.git` (an exported archive) it scans the file tree
 * instead, skipping only the root-level FALLBACK_SKIP directories; a file force-added under one of those is not seen in
 * that mode, and a directory at a covered path (how git archive exports a submodule entry) is listed, so that
 * classifyRepoPath rejects it.
 */
export function trackedHygieneFiles(root: string = repoRootPath): string[] {
  const covered = (p: string): boolean => hygieneKind(p) !== undefined;
  if (existsSync(join(root, '.git'))) {
    let listing: string;
    try {
      listing = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`A10 cannot list the tracked files (git ls-files failed in a git checkout): ${(e as Error).message}`);
    }
    return listing.split('\0').filter(covered).sort();
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // A directory named like a covered file is how an export (git archive) writes a submodule entry: list it, so
        // classifyRepoPath rejects it as it does in a git checkout.
        const kind = hygieneKind(relative(root, path));
        if (kind === 'jsonl' || kind === 'normalize_report') found.push(relative(root, path));
        if (!(dir === root && FALLBACK_SKIP.has(entry.name))) walk(path);
      } else if (covered(relative(root, path))) {
        found.push(relative(root, path));
      }
    }
  };
  walk(root);
  return found.sort();
}

export interface HistoryViolation {
  commit: string;
  path: string;
  reason: string;
}
export interface HistoryScan {
  commits: number;
  blobsChecked: number;
  violations: HistoryViolation[];
}

const git = (root: string, args: string[]): Buffer =>
  execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Every commit that `git rev-list <revArgs>` names (for a pull request, `<base>..<head>`), scanned with the same rule as
 * the tree under test: every path the rule covers in the tree of each of those commits is checked once per distinct
 * (blob, path) pair, oldest commit first, so a file added in one commit and deleted in a later one is still found and is
 * reported with the commit that brought it into the range. The tree of each commit is scanned whole, so a disallowed file
 * that the base already carried is reported too (with the range's first commit). A git failure, listing the range or
 * reading a blob, throws (the scan fails closed). A covered path that is a symbolic link or a submodule entry is a
 * violation, as in the tree under test.
 */
export function historyViolations(root: string, revArgs: string[]): HistoryScan {
  let commits: string[];
  try {
    commits = git(root, ['rev-list', '--reverse', ...revArgs]).toString('utf8').split('\n').filter((c) => c.length > 0);
  } catch (e) {
    throw new Error(`A10 history cannot list the commits of ${revArgs.join(' ')}: ${(e as Error).message}`);
  }
  const seen = new Set<string>();
  const violations: HistoryViolation[] = [];
  for (const commit of commits) {
    const entries = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter((e) => e.length > 0);
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      const [mode, type, sha] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      if (hygieneKind(path) === undefined || sha === undefined) continue;
      const key = `${sha}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hygieneKind(path) === 'capture_dir') {
        violations.push({ commit, path, reason: CAPTURE_DIR_REASON });
        continue;
      }
      if (type !== 'blob') {
        violations.push({ commit, path, reason: type === 'commit' ? SUBMODULE_REASON : `a ${String(type)} entry where the rule allows only a regular file` });
        continue;
      }
      if (mode === '120000') {
        violations.push({ commit, path, reason: SYMLINK_REASON });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = git(root, ['cat-file', 'blob', sha]);
      } catch (e) {
        throw new Error(`A10 history cannot read blob ${sha} (${JSON.stringify(path)}) of ${commit}: ${(e as Error).message}`);
      }
      let text: string;
      try {
        text = decodeStrict(bytes);
      } catch {
        violations.push({ commit, path, reason: NOT_UTF8_REASON });
        continue;
      }
      const verdict = classifyTrackedFile(path, text);
      if (!verdict.ok) violations.push({ commit, path, reason: verdict.reason });
    }
  }
  return { commits: commits.length, blobsChecked: seen.size, violations };
}
