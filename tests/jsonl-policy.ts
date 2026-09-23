// A10, the repository rule for JSONL (docs/M2_DATA_CONTRACT.md section 6.3, docs/M2_GROK_HANDOFF.md A10).
//
// Fail closed: every tracked .jsonl file must be one of the two allowed kinds below, and anything this policy cannot
// classify fails. The check is structural. It cannot see whether a rights note's attestation exists or clears its
// scope (the owner verifies that by hand); whether a file declared synthetic is in fact synthetic (recorded
// observations re-encoded in the version-1 format and labelled synthetic pass kind synthetic_v1); or a venue payload
// pasted into a string value of either kind, or into an open object of a recorded fixture. Review remains the control
// for those.
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
// Every other file fails: a raw capture record on any line, invalid JSON, a line that is not a JSON object, a first
// line that is not a fixture header (unwrapped venue frames, headerless events or objects), a version-1 header that is
// not synthetic, a version-2 synthetic header (the synthetic generator writes version 1), a recorded fixture without
// that rights shape, any other schema version, and an empty file.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * Reads a repository-relative path literally, as a path (never as a URL, where `?`, `#` and `%` would change it), and
 * decodes it as strict UTF-8: a byte sequence that is not UTF-8 throws instead of becoming U+FFFD, and a leading BOM is
 * kept (so JSON.parse rejects it). A text that decodes, re-encodes to the same bytes, which makes the synthetic kind's
 * text comparison a byte-for-byte one.
 */
export const readRepoFile = (path: string, root: string = repoRootPath): string =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(join(root, path)));

export type JsonlVerdict = { ok: true; kind: 'synthetic_v1' | 'recorded_v2_publishable' } | { ok: false; reason: string };

const captureSchema = readJson('schemas/capture-record.v1.schema.json');
const fixtureSchema = readJson('schemas/fixture.v2.schema.json');
const CAPTURE_RECORD_TYPES = new Set<string>(captureSchema.properties.type.enum);

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv, ['date', 'date-time', 'uuid']);
ajv.addSchema(fixtureSchema);
const schemaRef = (def: string): ValidateFunction => {
  const v = ajv.getSchema(`${fixtureSchema.$id as string}#/$defs/${def}`);
  if (!v) throw new Error(`fixture.v2 definition not found: ${def}`);
  return v;
};
const v2Header = schemaRef('header');
const v2Event = schemaRef('event');

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

const fail = (reason: string): JsonlVerdict => ({ ok: false, reason });
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

export function classifyJsonl(text: string): JsonlVerdict {
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

function classifySyntheticV1(text: string, header: Record<string, any>): JsonlVerdict {
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

function classifyRecordedV2(header: Record<string, any>, events: Record<string, any>[]): JsonlVerdict {
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

/**
 * Directories never scanned by the fallback, relative to the root: git's own, the dependencies, and the demo's and
 * build's output. Everything else is scanned, the ignored capture directories included.
 */
const FALLBACK_SKIP = new Set(['.git', 'node_modules', 'out', 'dist']);

/**
 * Every tracked file under `root` whose name ends in .jsonl (any letter case), as root-relative paths.
 *
 * In a git checkout (a `.git` entry at the root) the list comes from `git ls-files`, and a git failure there throws,
 * failing the test rather than guessing. Where the root has no `.git` (an exported archive) it scans the file tree
 * instead, skipping only the root-level FALLBACK_SKIP directories; a file force-added under one of those is not seen in
 * that mode.
 */
export function trackedJsonlFiles(root: string = repoRootPath): string[] {
  const isJsonl = (p: string): boolean => /\.jsonl$/i.test(p);
  if (existsSync(join(root, '.git'))) {
    let listing: string;
    try {
      listing = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`A10 cannot list the tracked files (git ls-files failed in a git checkout): ${(e as Error).message}`);
    }
    return listing.split('\0').filter(isJsonl).sort();
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(dir === root && FALLBACK_SKIP.has(entry.name))) walk(path);
      } else if (isJsonl(entry.name)) {
        found.push(relative(root, path));
      }
    }
  };
  walk(root);
  return found.sort();
}
