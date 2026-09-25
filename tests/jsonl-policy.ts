// A10, the repository rule for recorded data (docs/M2_DATA_CONTRACT.md section 6.5, docs/M2_GROK_HANDOFF.md A10).
//
// Fail closed: every tracked file the rule covers must be one of the allowed kinds below, and anything this policy
// cannot classify fails. The rule covers three kinds of path:
//
//   any path under a directory named captures/ or    never allowed, whatever the file (both directories are the
//   normalized/, at the root or at any depth         default output of the capture and normalize tools; .gitignore
//                                                    ignores them at any depth in lower case only, and keeps a file
//                                                    there out of a plain git add, not out of a commit: git add -f,
//                                                    git mv, git apply --index, git am or a .gitignore negation stage
//                                                    one, so the path is refused in any letter case)
//   a name ending in .normalize-report.json          must be named <captureId>.normalize-report.json for the captureId
//                                                    it carries and validate against the closed
//                                                    schemas/normalize-report.v1.schema.json (contract section 5.10);
//                                                    its bytes must be exactly its canonical serialization (every
//                                                    object's keys sorted, JSON.stringify with an indent of 2 and one
//                                                    newline); every number must be a safe integer; its arrays must be
//                                                    in the contract's order; each fixtureFile must name its own
//                                                    capture and segment; each rule must carry its own scope and
//                                                    fields; and its cross-references must agree (reportViolation)
//   a name ending in .jsonl                          must be one of the two allowed fixture kinds:
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
// Every other .jsonl file fails: a raw capture record on any line (or, in a recorded fixture, nested at any depth under
// any key of the header or an event), invalid JSON, a line that is not a JSON object, a
// first line that is not a fixture header (unwrapped venue frames, headerless events or objects), a version-1 header
// that is not synthetic, a version-2 synthetic header (the synthetic generator writes version 1), a recorded fixture
// without that rights shape, any other schema version, and an empty file. Names are matched in any letter case. A
// covered path that is a symbolic link or a submodule entry fails in both scopes, whatever it points to.
//
// The check is structural. It cannot see whether a rights note's attestation exists or clears its scope (the owner
// verifies that by hand); whether a file declared synthetic is in fact synthetic (recorded observations re-encoded in
// the version-1 format and labelled synthetic pass kind synthetic_v1); a venue payload pasted into a string value of
// either fixture kind, or under an undeclared key of a recorded fixture (unless it is a whole raw capture record); a recorded value encoded into a normalize report's
// constrained values (an integer in any integer field, the number of entries in an array, the choice among the
// enumerated codes a value may take or between null and a value, bytes hex-encoded into a hash, UUID, commit or
// version string, whether supersedes is present or empty, and the directory and number of committed reports). Every
// other tracked text file, and every commit message and header and annotated tag message the history scan and the hook
// read, gets only a content check (rawRecordLine): a raw capture record on a line of its own is found under any name,
// also block-quoted, after a trailer token, with a trailing comma or in a one-line JSON array, but not one spread over
// several lines, embedded in other text in any other way, encoded, compressed or in a file that is not UTF-8
// text, and no other form of recorded data (a recorded fixture or unwrapped venue frames under another name, a report
// under a name not ending in .normalize-report.json, exports of recorded values, values in names or identity fields).
// A tracked Git LFS pointer is refused, since its content lives outside git. Review remains the control for the rest.
//
// Two scopes use the same rule: trackedHygieneFiles lists the tree under test (the files tracked at this moment), and
// historyViolations scans every commit of a commit range, so a file added and deleted again inside the range is still
// found. Both detect; neither prevents anything that has already been pushed (contract section 6.5).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
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
  | { ok: true; kind: 'synthetic_v1' | 'recorded_v2_publishable' | 'normalize_report_v1' | 'other_text' | 'not_inspected' }
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

/** Whether a JSON value is, or holds at any depth, an object that is a raw capture record (walked iteratively, so a deeply
 * nested value cannot overflow the stack). */
function nestsRawRecord(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (isObject(v)) {
      if (isRawCaptureRecord(v)) return true;
      for (const x of Object.values(v)) stack.push(x);
    }
  }
  return false;
}

/** The line breaks that end a line: CR LF, LF and CR. JSON permits none of them unescaped inside a string. */
const LINE_BREAK = /\r\n|[\n\r]/;
/** The further breaks a line is also split at: VT, FF, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR. JSON permits NEL,
 * U+2028 and U+2029 unescaped inside a string, so a line is also tried whole, before and apart from these parts. */
const PART_BREAK = /[\v\f\u0085\u2028\u2029]/;
/** White space, control characters (Unicode Cc: the record separator of a JSON text sequence ...), format characters
 * (Unicode Cf: zero-width space, word joiner, byte order mark ...), marks (Unicode M: combining grapheme joiner,
 * variation selectors ...) and every other character the schemas' non-blank rule counts as invisible (fixture.v2
 * $defs/nonBlank: default-ignorable code points such as the Hangul fillers, and U+2800, U+303F, U+FFFC, U+13441, U+13442
 * and U+1D159) at either end of a line or part. The trailing run may start only after a character outside the class, so
 * a long run of padding inside a line costs linear time, not quadratic. */
const PADDING = String.raw`\s\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}\u2800\u303F\uFFFC\u{13441}\u{13442}\u{1D159}`;
const LINE_PADDING = new RegExp(`^[${PADDING}]+|(?<![${PADDING}])[${PADDING}]+$`, 'gu');

/** A markdown block quote's markers (`> `, `> > `) and a git trailer's token (`Raw-Record: `: a letter or digit, then
 * letters, digits and hyphens, a colon and white space) at the start of a line. */
const QUOTE_MARKERS = /^(?:>[ \t]*)+/;
const TRAILER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]*:\s+/;

/** Whether `text` is a JSON object that is a raw capture record, or a JSON array with one among its elements. */
function holdsRawRecord(text: string): boolean {
  if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return Array.isArray(value) ? value.some((e) => isObject(e) && isRawCaptureRecord(e)) : isObject(value) && isRawCaptureRecord(value);
}

/**
 * Whether `text`, trimmed of LINE_PADDING, holds a raw capture record: as it stands, after a markdown block quote's
 * markers, or after a trailer token as well, each also without one trailing comma, as a JSON object that is a raw
 * capture record or a JSON array with one among its elements.
 */
function isRawRecordText(text: string): boolean {
  const line = text.replace(LINE_PADDING, '');
  const unquoted = line.replace(QUOTE_MARKERS, '').replace(LINE_PADDING, '');
  const forms = [line, unquoted, unquoted.replace(TRAILER_TOKEN, '').replace(LINE_PADDING, '')];
  return forms.flatMap((f) => (f.endsWith(',') ? [f, f.slice(0, -1).replace(LINE_PADDING, '')] : [f])).some(holdsRawRecord);
}

/**
 * The 1-based number of the first line of `text` that holds a raw capture record, or undefined. This is the content
 * check applied to every tracked text file the three kinds above do not cover: it finds a raw capture written one record
 * per line under any name (.ndjson, .txt, .log, .json ...). Lines end at CR LF, LF or CR. Each line is tried whole, so a
 * record whose string values hold NEL, U+2028 or U+2029 is still found, and each part of it between the further breaks
 * of PART_BREAK is tried too; each is trimmed of white space, control and format characters and marks at both ends
 * first, and tried as it stands, block-quoted, after a trailer token, with a trailing comma, and as a one-line JSON
 * array (isRawRecordText). It cannot see a record spread over several lines, embedded in other text in any other way,
 * compressed, encoded or in a binary file (contract 6.5).
 */
export function rawRecordLine(text: string): number | undefined {
  for (const [i, line] of text.split(LINE_BREAK).entries()) {
    if (isRawRecordText(line)) return i + 1;
    const parts = line.split(PART_BREAK);
    if (parts.length > 1 && parts.some(isRawRecordText)) return i + 1;
  }
  return undefined;
}

/**
 * The version URLs git-lfs accepts in a pointer: its `v1Aliases`, the public launch, pre-release and alpha forms
 * (git-lfs lfs/pointer.go, read at commit 0043a64).
 */
const LFS_VERSIONS = new Set(['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1', 'http://git-media.io/v/2']);
/** The leading bytes git-lfs reads to decode a pointer (its `BlobSizeCutoff`), whatever the blob's size. */
const LFS_POINTER_BYTES = 1024;
/** A pointer extension key, which git-lfs accepts on any line before `version` (its `extRE`, a prefix match). */
const LFS_EXT_KEY = /^ext-\d-\w+/i;
/** White space git-lfs trims at both ends before it decodes (Go's unicode.IsSpace, NEL included), and the byte order mark. */
const LFS_EDGE = /^[\s\x85\ufeff]+/u;

/**
 * Whether git-lfs could take `bytes` for a pointer, whatever else they hold. This follows git-lfs's own decoder
 * (lfs/pointer.go DecodeFrom and decodeKVData at commit 0043a64) and refuses more than it accepts, never less: it reads
 * the first 1024 bytes as git-lfs does, on the raw bytes rather than only on UTF-8 text (a pointer's extension line may
 * hold bytes that are not UTF-8), trims white space at the start (a byte order mark too), skips empty and blank lines and
 * `ext-N-name` lines, and takes the text for a pointer when the first other line is `version` followed by any of the
 * version URLs git-lfs accepts, in any letter case and with any spacing. git-lfs also requires valid `oid` and `size`
 * lines; this check does not, so a file that only begins like a pointer is refused as well (fail closed).
 */
export function isLfsPointer(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, LFS_POINTER_BYTES)).replace(LFS_EDGE, '');
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line.length === 0) continue;
    const [key = '', ...rest] = line.split(/[ \t]+/);
    if (LFS_EXT_KEY.test(key)) continue;
    return key.toLowerCase() === 'version' && LFS_VERSIONS.has(rest.join(' ').toLowerCase());
  }
  return false;
}

/** The verdict for a tracked file outside the three kinds: a Git LFS pointer is refused, since its content lives in the
 * LFS store outside git, where no layer reads it; other text is checked for raw capture record lines; bytes that are not
 * UTF-8 (binary or compressed files) are not inspected. */
export function classifyOtherFile(bytes: Uint8Array): Verdict {
  // Before the UTF-8 test: git-lfs decodes a pointer from its bytes, and one of its lines may hold bytes that are not UTF-8.
  if (isLfsPointer(bytes)) return fail('a Git LFS pointer, whose content lives in the LFS store outside git, where no layer reads it');
  let text: string;
  try {
    text = decodeStrict(bytes);
  } catch {
    return { ok: true, kind: 'not_inspected' };
  }
  const line = rawRecordLine(text);
  return line === undefined ? { ok: true, kind: 'other_text' } : fail(`line ${line} holds a raw capture record, in a file the fixture rules do not cover`);
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
  // Every object of a recorded fixture accepts undeclared keys (contract section 6), so a whole raw capture record could
  // ride under one; the byte-for-byte check of PR-1's extension does not close the header, which the engine keeps as parsed.
  const nested = [header, ...events].findIndex((v) => Object.values(v).some(nestsRawRecord));
  if (nested >= 0) return fail(`non-blank line ${nested + 1} carries a raw capture record nested under one of its keys`);
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
  R4: { scope: 'item', fields: ['pair', 'price', 'size', null] },
  R5: { scope: 'capture', fields: ['priceDecimals', 'qtyDecimals', 'priceIncrement', 'qtyIncrement', 'instrumentSpec', 'pair', 'status'] },
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

/** The R4 dropped keys, each with the field its rejections name (contract sections 5.5 and 5.10). */
const R4_KEY_FIELDS: Record<string, string | null> = { foreignSymbol: 'pair', nonPositiveTradeSize: 'size', offTickPrice: 'price', offLotSize: 'size', undecodable: null };
/** The rules whose rejection names no single record (contract section 5.10). */
const AT_NULL_RULES = new Set(['R2', 'R2b', 'R5', 'R7', 'R8']);

/** The first number in `value` that is not a safe integer (so JSON.stringify would write it with an exponent or a point). */
function unsafeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? undefined : value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = unsafeNumber(v);
      if (bad !== undefined) return bad;
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) {
      const bad = unsafeNumber(v);
      if (bad !== undefined) return bad;
    }
  }
  return undefined;
}

/**
 * The first way a schema-valid report breaks the order, naming, pairing and cross-reference rules of contract sections
 * 5.10 and 6.5, or undefined. Order and naming: every number a safe integer; raw files and segments numbered from 0 in
 * order; cuts and each dropped entry's records in strictly ascending raw-record order (so no record twice, and no more
 * records than the count); rejections strictly ascending by (at, segmentIndex, rule, field); supersedes by
 * segmentIndex; a run refused at capture level listing exactly one rejection; each fixtureFile naming its own capture
 * and segment; each rule with its one scope and its own fields
 * (R3, a cut, is never a rejection); a segment rejection naming the rule its segment names; too_short exactly under R7.
 * Cross-references: every raw record reference inside the listed raw files (at most one record past a file's
 * file_end, the record R1b names when one follows it, or in the last file its manifest_end); segments in raw order, each start not after its end, without
 * overlap; start reasons following the previous segment's end reason; capture_end only on the last segment; exactly
 * one segment rejection for each refused or too_short segment and none for a written one; each cut after the end of
 * the segment it names, with that segment's end reason, and at most one per segment; a rejection's at null exactly for
 * R2, R2b, R5, R7 and R8; each R4 rejection matching a record of its dropped key and the reverse, with the segmentIndex
 * of the segment whose span holds its record, or null; and no supersedes entry repeating a segment this run wrote. It
 * checks consistency, not truth, and not the rest of section 5.10 (which cuts a segment deserved, whether counts add up).
 */
function reportViolation(r: Record<string, any>): string | undefined {
  const unsafe = unsafeNumber(r);
  if (unsafe !== undefined) return `a number (${String(unsafe)}) that is not a safe integer`;
  if (r.rejections.some((j: any) => j.scope === 'capture') && r.rejections.length !== 1) return 'a run refused at capture level that lists more than its one rejection';
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
  return crossReferenceViolation(r);
}

/** The cross-reference part of reportViolation. */
function crossReferenceViolation(r: Record<string, any>): string | undefined {
  const files = r.rawFiles as { records: number }[];
  const refs: RecordRef[] = [
    ...r.segments.flatMap((s: any) => [s.start, s.end]),
    ...r.cuts.map((c: any) => c.at),
    ...r.rejections.map((j: any) => j.at),
    ...Object.values<any>(r.dropped).flatMap((e) => e.records),
  ];
  for (const ref of refs) {
    if (ref === null) continue;
    const file = files[ref.fileIndex];
    const limit = file === undefined ? -1 : file.records + 1;
    if (ref.record > limit) return `a raw record reference ${ref.fileIndex}:${ref.record} outside the raw files the report lists`;
  }
  const cmp = (a: RecordRef, b: RecordRef): number => compareKeys(refKey(a), refKey(b));
  const segments = r.segments as any[];
  for (const [i, s] of segments.entries()) {
    if (cmp(s.start, s.end) > 0) return `segment ${i} starts after its end`;
    if (i > 0 && cmp(segments[i - 1].end, s.start) >= 0) return `segment ${i} does not start after segment ${i - 1} ends`;
    const startReason = i === 0 ? 'capture_start' : segments[i - 1].endReason === 'clock_cut' ? 'resync_after_clock_cut' : 'resync_after_gap';
    if (s.startReason !== startReason) return `segment ${i} starts with ${s.startReason}, not ${startReason}`;
    if (s.endReason === 'capture_end' && i !== segments.length - 1) return `segment ${i} ends with capture_end but is not the last segment`;
    const own = r.rejections.filter((j: any) => j.scope === 'segment' && j.segmentIndex === i).length;
    if (own !== (s.status === 'written' ? 0 : 1)) return `segment ${i} (${s.status}) with ${own} segment rejections`;
  }
  const cutSegments = new Set<number>();
  for (const c of r.cuts) {
    const s = segments[c.segmentIndex];
    if (s === undefined) return `a cut for segment ${c.segmentIndex}, which the report does not list`;
    if (cutSegments.has(c.segmentIndex)) return `two cuts for segment ${c.segmentIndex}`;
    cutSegments.add(c.segmentIndex);
    if (c.reason !== s.endReason) return `a cut ${c.reason} for segment ${c.segmentIndex}, which ends with ${s.endReason}`;
    if (cmp(s.end, c.at) >= 0) return `a cut for segment ${c.segmentIndex} that is not after its end`;
  }
  const r4 = new Set<string>();
  for (const j of r.rejections) {
    if ((j.at === null) !== AT_NULL_RULES.has(j.rule)) return `rule ${j.rule} with at ${j.at === null ? 'null' : 'a record'}`;
    if (j.rule !== 'R4') continue;
    const holder = segments.findIndex((s) => cmp(s.start, j.at) <= 0 && cmp(j.at, s.end) <= 0);
    if (j.segmentIndex !== (holder === -1 ? null : holder)) return `an R4 rejection at ${j.at.fileIndex}:${j.at.record} with segmentIndex ${String(j.segmentIndex)}, not that of the segment whose span holds it`;
    r4.add(`${j.at.fileIndex}:${j.at.record}:${String(j.field)}`);
  }
  const dropped = new Set<string>();
  for (const [key, field] of Object.entries(R4_KEY_FIELDS)) {
    for (const ref of r.dropped[key]?.records ?? []) dropped.add(`${ref.fileIndex}:${ref.record}:${String(field)}`);
  }
  const unmatched = [...r4].find((k) => !dropped.has(k)) ?? [...dropped].find((k) => !r4.has(k));
  if (unmatched !== undefined) return `the R4 rejections and the records of the R4 dropped keys disagree at ${unmatched}`;
  const repeated = (r.supersedes ?? []).find((e: any) => segments[e.segmentIndex]?.status === 'written' && segments[e.segmentIndex].fixtureSha256 === e.fixtureSha256);
  if (repeated) return `a supersedes entry for segment ${repeated.segmentIndex} that this run reproduces`;
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
  const disorder = reportViolation(value as Record<string, any>);
  if (disorder !== undefined) return fail(`a normalize report that breaks the order or cross-reference rules of contract section 5.10: ${disorder}`);
  return { ok: true, kind: 'normalize_report_v1' };
}

export type HygieneKind = 'capture_dir' | 'normalize_report' | 'jsonl';
const CAPTURE_DIR_REASON = 'a file under a captures/ or normalized/ directory, which never enter Git, whatever the file';
const SYMLINK_REASON = 'a symbolic link where the rule allows only a regular file';
const SUBMODULE_REASON = 'a submodule entry where the rule allows only a regular file';
const SUBMODULE_ANYWHERE_REASON = 'a submodule entry, whose content lives in another repository, where no layer reads it';
const NOT_UTF8_REASON = 'bytes that are not UTF-8';
const MISSING_REASON = 'a tracked path that is missing from the working tree';
const NOT_FILE_REASON = 'a path that is not a regular file where the rule allows only a regular file';
const NOT_UTF8_NAME_REASON = 'a covered path whose name is not UTF-8, which the rule cannot read by name';
const UNREADABLE_ENTRY_REASON = 'a tracked entry whose blob git cannot read, so the content check cannot run';
const MISSING_OTHER_REASON = 'a path neither in the index nor present in the working tree';

/**
 * A path as git records it, as text without loss: UTF-8 names as they are; for any other name every byte from 0x80 up,
 * and every backslash, written as \\xHH, and `utf8` false, so a name that is not UTF-8 is never read under another name
 * and two such names never become one.
 */
export interface GitPath {
  path: string;
  utf8: boolean;
}
export function gitPathText(bytes: Uint8Array): GitPath {
  try {
    return { path: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), utf8: true };
  } catch {
    let path = '';
    for (const b of bytes) path += b >= 0x80 || b === 0x5c ? `\\x${b.toString(16).padStart(2, '0')}` : String.fromCharCode(b);
    return { path, utf8: false };
  }
}

/** The records of a NUL-terminated git listing (`-z`), each split at its first tab into the header and the path. */
function zRecords(listing: Buffer): { head: string; name: GitPath }[] {
  const records: { head: string; name: GitPath }[] = [];
  let start = 0;
  while (start < listing.length) {
    let end = listing.indexOf(0, start);
    if (end < 0) end = listing.length;
    const record = listing.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error(`A10 cannot parse a git listing record: ${JSON.stringify(record.toString('latin1'))}`);
    records.push({ head: record.subarray(0, tab).toString('latin1'), name: gitPathText(record.subarray(tab + 1)) });
  }
  return records;
}

/** One entry of the index (`git ls-files -s -z`): its mode, object id and path. */
export interface IndexEntry extends GitPath {
  mode: string;
  oid: string;
}
/** The index of the git checkout at `root`, every entry; a git failure throws, so the test fails rather than guessing. */
export function indexEntries(root: string = repoRootPath): IndexEntry[] {
  let listing: Buffer;
  try {
    listing = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, env: GIT_SCAN_ENV, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`A10 cannot list the tracked files (git ls-files failed in a git checkout): ${(e as Error).message}`);
  }
  return zRecords(listing).map(({ head, name }) => {
    const [mode = '', oid = ''] = head.split(' ');
    return { mode, oid, ...name };
  });
}

/**
 * The environment of every git command the rule runs: replace refs (git replace) are ignored, so the scan reads the
 * objects a push sends, not replacements the clone substitutes for them.
 */
export const GIT_SCAN_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };

/** Whether git records `path` as a submodule entry (mode 160000) in the index of `root`; a git failure throws. */
const isGitlink = (root: string, path: string): boolean =>
  execFileSync('git', ['ls-files', '-s', '-z', '--', path], {
    cwd: root,
    encoding: 'utf8',
    env: { ...GIT_SCAN_ENV, GIT_LITERAL_PATHSPECS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).startsWith('160000 ');

/** Which part of the rule covers a repository-relative path, or undefined when the rule does not cover it. */
export function hygieneKind(path: string): HygieneKind | undefined {
  if (/(^|\/)(captures|normalized)\//i.test(path)) return 'capture_dir';
  if (/\.normalize-report\.json$/i.test(path)) return 'normalize_report';
  if (/\.jsonl$/i.test(path)) return 'jsonl';
  return undefined;
}

/** The verdict for a path the rule covers, given its decoded content. */
export function classifyTrackedFile(path: string, text: string): Verdict {
  switch (hygieneKind(path)) {
    case 'capture_dir':
      return fail(CAPTURE_DIR_REASON);
    case 'normalize_report': {
      const verdict = classifyNormalizeReport(text);
      if (!verdict.ok) return verdict;
      const name = path.slice(path.lastIndexOf('/') + 1);
      const captureId = (JSON.parse(text) as { captureId: string }).captureId;
      return name === `${captureId}.normalize-report.json` ? verdict : fail(`a normalize report whose file name is not ${captureId}.normalize-report.json, the name for the capture it carries`);
    }
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
    // Without loss (gitPathText): a covered name that is not UTF-8 is listed in its escaped form, which names no file,
    // so classifyRepoPath refuses it rather than reading another file or none.
    return [...new Set(indexEntries(root).map((e) => e.path))].filter(covered).sort();
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

/**
 * Every tracked path the three kinds do not cover, as root-relative paths, for classifyOtherPath: regular files and
 * symbolic links (whose target text git stores as their content) for the content check, and submodule entries, which
 * are refused anywhere; in a checkout without .git the same fallback walk as trackedHygieneFiles is used, which lists
 * regular files and symbolic links.
 */
export function trackedOtherFiles(root: string = repoRootPath): string[] {
  const other = (p: string): boolean => hygieneKind(p) === undefined;
  if (existsSync(join(root, '.git'))) {
    return trackedOtherEntries(root).map((e) => e.path);
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(dir === root && FALLBACK_SKIP.has(entry.name))) walk(path);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && other(relative(root, path))) {
        found.push(relative(root, path));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Every index entry of the git checkout at `root` outside the three kinds, whatever its mode, sorted by path: each is
 * classified by classifyOtherEntry, which reads it or refuses it.
 */
export function trackedOtherEntries(root: string = repoRootPath): IndexEntry[] {
  return indexEntries(root)
    .filter((e) => hygieneKind(e.path) === undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The verdict for one index entry outside the three kinds. Fail closed: the entry is read, or it is refused. A submodule
 * entry is refused, since its content lives in another repository. A regular file's or a symbolic link's blob (the
 * link's target text) is read from the index by its object id, so an entry is checked whether or not the working tree
 * holds it (a skip-worktree or sparse entry, a file deleted without `git rm`, a name that is not UTF-8), and a blob git
 * cannot read, or a mode the rule does not know, is refused. When the name is UTF-8 and the working tree holds a file or
 * link there, its bytes are checked too, so an unstaged change is not missed. Bytes that are not UTF-8 are read and not
 * content-checked (classifyOtherFile), as in the history scan.
 */
export function classifyOtherEntry(entry: IndexEntry, root: string = repoRootPath): Verdict {
  if (entry.mode === '160000') return fail(SUBMODULE_ANYWHERE_REASON);
  if (!/^(100644|100755|120000)$/.test(entry.mode)) return fail(`an index entry of mode ${entry.mode}, which the rule does not read`);
  let blob: Buffer;
  try {
    blob = git(root, ['cat-file', 'blob', entry.oid]);
  } catch {
    return fail(UNREADABLE_ENTRY_REASON);
  }
  const verdict = classifyOtherFile(blob);
  if (!verdict.ok || !entry.utf8) return verdict;
  const stat = lstatSync(join(root, entry.path), { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) return worse(verdict, classifyOtherFile(readlinkSync(join(root, entry.path), { encoding: 'buffer' })));
  if (stat?.isFile()) return worse(verdict, classifyOtherFile(readFileSync(join(root, entry.path))));
  return verdict;
}

/** The first failing verdict of two, else the first. */
const worse = (a: Verdict, b: Verdict): Verdict => (a.ok ? (b.ok ? a : b) : a);

/**
 * The verdict for a path outside the three kinds, read from `root`. In a git checkout the path's index entries are
 * classified by classifyOtherEntry; a path the index does not hold is read from the working tree, and refused when it is
 * not there either. Where the root has no `.git` (an exported archive) the file tree is read: a directory there (how
 * git archive writes a submodule entry at a path no kind covers cannot be told from a directory) and any other non-file
 * is not inspected, and a missing path is refused.
 */
export function classifyOtherPath(path: string, root: string = repoRootPath): Verdict {
  if (existsSync(join(root, '.git'))) {
    const entries = indexEntries(root).filter((e) => e.utf8 && e.path === path);
    if (entries.length > 0) return entries.map((e) => classifyOtherEntry(e, root)).reduce(worse);
  }
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (stat === undefined) return fail(MISSING_OTHER_REASON);
  if (stat.isSymbolicLink()) return classifyOtherFile(readlinkSync(join(root, path), { encoding: 'buffer' }));
  if (!stat.isFile()) return { ok: true, kind: 'not_inspected' };
  return classifyOtherFile(readFileSync(join(root, path)));
}

export interface HistoryViolation {
  commit: string;
  path: string;
  reason: string;
}
export interface HistoryScan {
  commits: number;
  blobsChecked: number;
  /** Distinct blobs outside the three kinds that the line-by-line content check read. */
  otherBlobsChecked: number;
  violations: HistoryViolation[];
}

const git = (root: string, args: string[]): Buffer =>
  execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, env: GIT_SCAN_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

/** A blob's bytes; a git failure throws, so the scan fails closed. */
const readBlob = (root: string, sha: string, path: string, commit: string): Buffer => {
  try {
    return git(root, ['cat-file', 'blob', sha]);
  } catch (e) {
    throw new Error(`A10 history cannot read blob ${sha} (${JSON.stringify(path)}) of ${commit}: ${(e as Error).message}`);
  }
};

/**
 * The raw capture records in the message and header of the annotated tag `sha`, and of every tag it points to in turn
 * (a tag of a tag), found with the content check (rawRecordLine); an object that is not a tag has none. A git failure throws, so the
 * check fails closed. The hook runs it for every annotated tag it pushes; nothing on GitHub runs it (contract 6.5).
 */
export function tagMessageViolations(root: string, sha: string): HistoryViolation[] {
  const violations: HistoryViolation[] = [];
  let object = sha;
  for (let depth = 0; depth < 64; depth++) {
    let text: string;
    try {
      if (git(root, ['cat-file', '-t', object]).toString('utf8').trim() !== 'tag') return violations;
      text = git(root, ['cat-file', 'tag', object]).toString('utf8');
    } catch (e) {
      throw new Error(`A10 cannot read tag object ${object}: ${(e as Error).message}`);
    }
    const blank = text.indexOf('\n\n');
    const line = blank < 0 ? undefined : rawRecordLine(text.slice(blank + 2));
    if (line !== undefined) violations.push({ commit: object, path: '(tag message)', reason: `line ${line} of the tag message holds a raw capture record` });
    const headerLine = rawRecordLine(blank < 0 ? text : text.slice(0, blank));
    if (headerLine !== undefined) violations.push({ commit: object, path: '(tag header)', reason: `line ${headerLine} of the tag header holds a raw capture record` });
    const target = /^object ([0-9a-f]+)$/m.exec(blank < 0 ? text : text.slice(0, blank));
    if (!target) throw new Error(`A10 cannot read the target of tag object ${object}`);
    object = target[1]!;
  }
  throw new Error(`A10 stopped following tag ${sha}: more than 64 nested tags`);
}

/**
 * Every commit that `git rev-list <revArgs>` names (for a pull request, `<base>..<head>`), scanned with the same rule as
 * the tree under test: every path the rule covers in the tree of each of those commits is checked once per distinct
 * (blob, path) pair, oldest commit first, so a file added in one commit and deleted in a later one is still found and is
 * reported with the commit that brought it into the range. The tree of each commit is scanned whole, so a disallowed file
 * that the base already carried is reported too (with the range's first commit). A git failure, listing the range or
 * reading a blob, throws (the scan fails closed). A covered path that is a symbolic link or a submodule entry is a
 * violation, as in the tree under test. Every other regular file of each commit is checked once per distinct blob with
 * the line-by-line content check (classifyOtherFile), and each commit's message with the same check.
 */
export function historyViolations(root: string, revArgs: string[]): HistoryScan {
  let commits: string[];
  try {
    commits = git(root, ['rev-list', '--reverse', ...revArgs]).toString('utf8').split('\n').filter((c) => c.length > 0);
  } catch (e) {
    throw new Error(`A10 history cannot list the commits of ${revArgs.join(' ')}: ${(e as Error).message}`);
  }
  const seen = new Set<string>();
  const otherSeen = new Set<string>();
  const violations: HistoryViolation[] = [];
  for (const commit of commits) {
    // The commit message: a raw capture record pasted into it is published with the commit.
    let object: string;
    try {
      object = git(root, ['cat-file', 'commit', commit]).toString('utf8');
    } catch (e) {
      throw new Error(`A10 history cannot read commit ${commit}: ${(e as Error).message}`);
    }
    const blank = object.indexOf('\n\n');
    const messageLine = blank < 0 ? undefined : rawRecordLine(object.slice(blank + 2));
    if (messageLine !== undefined) violations.push({ commit, path: '(commit message)', reason: `line ${messageLine} of the commit message holds a raw capture record` });
    // The header too: merging a signed tag copies the tag, its message included, into a mergetag header whose
    // continuation lines start with a space (rawRecordLine trims them).
    const headerLine = rawRecordLine(blank < 0 ? object : object.slice(0, blank));
    if (headerLine !== undefined) violations.push({ commit, path: '(commit header)', reason: `line ${headerLine} of the commit header (a mergetag, for example) holds a raw capture record` });
    // Paths without loss (gitPathText): a name that is not UTF-8 is shown escaped, never read as another name.
    for (const { head, name } of zRecords(git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]))) {
      const [mode, type, sha] = head.split(' ');
      const path = name.path;
      if (sha === undefined) throw new Error(`A10 history cannot parse a tree entry of ${commit}: ${JSON.stringify(head)}`);
      if (hygieneKind(path) === undefined) {
        // Outside the three kinds: a submodule entry is refused anywhere, since its content lives in another repository;
        // a regular file's or a symbolic link's blob (the link's target text) gets the content check, once per blob.
        if (type === 'commit') {
          const key = `${sha}\0${path}`;
          if (!seen.has(key)) violations.push({ commit, path, reason: SUBMODULE_ANYWHERE_REASON });
          seen.add(key);
          continue;
        }
        if (type !== 'blob' || otherSeen.has(sha)) continue;
        otherSeen.add(sha);
        const verdict = classifyOtherFile(readBlob(root, sha, path, commit));
        if (!verdict.ok) violations.push({ commit, path, reason: verdict.reason });
        continue;
      }
      const key = `${sha}\0${name.utf8 ? 'u' : 'b'}${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!name.utf8) {
        violations.push({ commit, path, reason: NOT_UTF8_NAME_REASON });
        continue;
      }
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
      const bytes = readBlob(root, sha, path, commit);
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
  return { commits: commits.length, blobsChecked: seen.size, otherBlobsChecked: otherSeen.size, violations };
}
