// A10 (docs/M2_GROK_HANDOFF.md; docs/M2_DATA_CONTRACT.md section 6.5): every tracked .jsonl file must be an allowed
// fixture, every tracked normalize report must match its closed schema, nothing under captures/ or normalized/ may be
// tracked, and the rule fails closed on anything it cannot classify, in the tree under test and in every commit of a
// range. The constructed cases below are illustrative:
// the venue frames use the public WebSocket API v2 field names with invented values, and a passing recorded-fixture
// case shows only that the rights block has the required shape. It establishes no permission; the owner verifies the
// attested clearance by hand before any recorded fixture is committed (decision condition C2).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalReport,
  classifyJsonl,
  classifyNormalizeReport,
  classifyOtherFile,
  classifyOtherEntry,
  classifyOtherPath,
  gitPathText,
  classifyRepoPath,
  classifyTrackedFile,
  historyViolations,
  readRepoFile,
  tagMessageViolations,
  repoRootPath,
  trackedHygieneFiles,
  trackedOtherEntries,
  trackedOtherFiles,
} from './jsonl-policy.js';

type Json = Record<string, any>;
const read = (path: string): string => readRepoFile(path);
const readJson = (path: string): Json => JSON.parse(read(path));
const jsonl = (values: unknown[]): string => values.map((v) => JSON.stringify(v)).join('\n') + '\n';

const synthetic = read('fixtures/synthetic-baseline.jsonl');
const syntheticLines = synthetic.split('\n').filter((l) => l.length > 0);
const syntheticHeader = (): Json => JSON.parse(syntheticLines[0]!);
const withLines = (lines: string[]): string => lines.join('\n') + '\n';
/** The synthetic fixture with its first trade event changed by `change`. */
function withTrade(change: (trade: Json) => void): string {
  const i = syntheticLines.findIndex((l) => JSON.parse(l).type === 'trade');
  const trade = JSON.parse(syntheticLines[i]!);
  change(trade);
  return withLines([...syntheticLines.slice(0, i), JSON.stringify(trade), ...syntheticLines.slice(i + 1)]);
}

const fixtureExamples = readJson('schemas/examples/fixture.v2.examples.json').examples as Record<string, Json>;
const captureExamples = readJson('schemas/examples/capture-record.v1.examples.json').examples as Record<string, Json>;
const reportExamples = readJson('schemas/examples/normalize-report.v1.examples.json').examples as Record<string, Json>;
const fixtureSchema = readJson('schemas/fixture.v2.schema.json');
/** The only name a tracked report of the example capture may have (contract section 6.5). */
const REPORT_NAME = `${reportExamples.report_segments!.captureId}.normalize-report.json`;
const report = (change: (r: Json) => void = () => {}): string => {
  const r = structuredClone(reportExamples.report_segments!);
  change(r);
  return canonicalReport(r);
};
const v2Events = [fixtureExamples.event_book!, fixtureExamples.event_trade!];

/** A version-2 recorded fixture built from the constructed schema examples, with its rights block adjusted by `rights`. */
function recordedFixture(rights: (r: Json) => void, header: (h: Json) => void = () => {}): string {
  const h = structuredClone(fixtureExamples.header_recorded_qty8!);
  h.eventCount = v2Events.length;
  rights(h.provenance.rights);
  header(h);
  return jsonl([h, ...v2Events]);
}
const publishable = (r: Json): void => {
  r.redistribution = 'permitted';
  r.publication = 'sample_permitted';
  r.note = 'constructed placeholder: a real note identifies the owner attestation on pull request #3; this text establishes nothing';
};

// Unwrapped venue frames: what a capture stores, as text, in a `message` record's `payload` field, here without the
// capture record around it.
const venueFrames = {
  bookSnapshot: { channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 62710.5, qty: 0.25 }], asks: [{ price: 62710.6, qty: 0.1 }], checksum: 1234567890 }] },
  bookUpdate: { channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: [{ price: 62710.4, qty: 0 }], asks: [], checksum: 987654321, timestamp: '2026-10-06T12:00:00.123456Z' }] },
  trade: { channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: 'buy', price: 62710.6, qty: 0.01, ord_type: 'market', trade_id: 1, timestamp: '2026-10-06T12:00:00.130000Z' }] },
  heartbeat: { channel: 'heartbeat' },
  subscribeAck: { method: 'subscribe', result: { channel: 'book', symbol: 'BTC/USD', depth: 100, snapshot: true }, success: true, time_in: '2026-10-06T12:00:00.000000Z', time_out: '2026-10-06T12:00:00.000100Z', req_id: 1 },
};

describe('A10: every tracked file the rule covers is allowed (fail closed)', () => {
  const files = trackedHygieneFiles();

  it('finds the committed synthetic fixtures among the tracked files the rule covers', () => {
    expect(files).toEqual(expect.arrayContaining(['fixtures/synthetic-baseline.jsonl', 'fixtures/synthetic-riskgate.jsonl']));
  });

  it.each(files)('%s is an allowed file', (path) => {
    expect(classifyRepoPath(path)).toEqual({ ok: true, kind: expect.any(String) });
  });

  it('finds no raw capture record on a line of its own in any other tracked text file, whatever its name', () => {
    const other = trackedOtherEntries();
    expect(other.map((e) => e.path)).toEqual(expect.arrayContaining(['README.md', 'package.json', 'schemas/examples/capture-record.v1.examples.json']));
    expect(other.map((e) => ({ path: e.path, verdict: classifyOtherEntry(e) })).filter((f) => !f.verdict.ok)).toEqual([]);
  });

  it('ships the pre-push hook executable (git skips a hook that is not, and the push goes through)', () => {
    // In an exported archive (no .git) only the file mode can be checked; in a git checkout a git failure fails the test.
    if (existsSync(join(repoRootPath, '.git'))) {
      const tracked = execFileSync('git', ['ls-files', '-s', '.githooks/pre-push'], { cwd: repoRootPath, encoding: 'utf8', env: GIT_ENV });
      if (tracked.length > 0) expect(tracked).toMatch(/^100755 /);
    }
    expect(statSync(join(repoRootPath, '.githooks', 'pre-push')).mode & 0o111).not.toBe(0);
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'a10-'));
  temps.push(root);
  return root;
};
const tempTree = (files: Record<string, string | Buffer>): string => {
  const root = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
// Temporary repositories ignore the host's global and system git configuration (identity, signing, hooks, ignore files,
// templates), commit with a fixed identity and run no hook unless a test enables one in the repository itself.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const IDENTITY = ['-c', 'user.name=a10-test', '-c', 'user.email=a10-test@example.invalid', '-c', 'commit.gpgsign=false'];
const gitIn = (root: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const newRepo = (files: Record<string, string | Buffer>): string => {
  const root = tempTree(files);
  gitIn(root, 'init', '-q', '-b', 'main');
  return root;
};
const commitAll = (root: string, message: string): string => {
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '--allow-empty', '-m', message);
  return gitIn(root, 'rev-parse', 'HEAD').trim();
};
const raw = jsonl([captureExamples.manifest_start, captureExamples.message_book_update]);
/** The example trade record written on one line, its payload string holding `separator` unescaped, as JSON permits for NEL, U+2028 and U+2029. */
const tradeWithBreak = (separator: string): string => {
  const trade = captureExamples.message_trade as { payload: string };
  return JSON.stringify({ ...captureExamples.message_trade, payload: trade.payload.replace('"trade"', `"tr${separator}ade"`) });
};
const TSX = join(repoRootPath, 'node_modules', '.bin', 'tsx');
const HISTORY_CLI = join(repoRootPath, 'tests', 'a10-history-cli.ts');

describe('A10 file listing (the tree under test)', () => {
  it('lists tracked names literally and reads them as paths, so ?, #, % and backslashes cannot redirect it', () => {
    const odd = ['fixtures/synthetic-baseline.jsonl?raw.jsonl', 'fixtures/synthetic-baseline.jsonl#raw.jsonl', 'raw%41.jsonl', 'x\\y.jsonl', 'CAPS.JSONL'];
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic, ...Object.fromEntries(odd.map((p) => [p, raw])) });
    gitIn(root, 'add', '-A', '-f');
    const listed = trackedHygieneFiles(root);
    expect(listed).toEqual(expect.arrayContaining(odd));
    for (const path of odd) expect(classifyTrackedFile(path, readRepoFile(path, root))).toMatchObject({ ok: false, reason: expect.stringMatching(/raw capture record/) });
    expect(classifyTrackedFile('fixtures/synthetic-baseline.jsonl', readRepoFile('fixtures/synthetic-baseline.jsonl', root))).toEqual({ ok: true, kind: 'synthetic_v1' });
  });

  it('lists every file force-added under a captures/ or normalized/ directory, at any depth and whatever its name, and rejects each', () => {
    const inCaptureDirs = ['captures/123e4567-e89b-42d3-a456-426614174000-0.jsonl', 'captures/notes.txt', 'normalized/seg0.jsonl', 'normalized/run.normalize-report.json', 'normalized/deep/x.bin', 'Captures/x.jsonl.gz', 'NORMALIZED/notes.txt', 'sub/captures/raw.bin', 'a/b/Normalized/x.txt'];
    const root = newRepo({ '.gitignore': 'captures/\nnormalized/\nCaptures/\nNORMALIZED/\n', 'fixtures/synthetic-baseline.jsonl': synthetic, ...Object.fromEntries(inCaptureDirs.map((p) => [p, raw])) });
    gitIn(root, 'add', '-A', '-f');
    expect(trackedHygieneFiles(root)).toEqual([...inCaptureDirs, 'fixtures/synthetic-baseline.jsonl'].sort());
    for (const path of inCaptureDirs) expect(classifyRepoPath(path, root)).toMatchObject({ ok: false, reason: expect.stringMatching(/under a captures\/ or normalized\/ directory/) });
  });

  it('the repository .gitignore ignores captures/ and normalized/ in lower case only, and does not keep them out of a commit; the rule refuses them in any letter case', () => {
    const root = newRepo({ '.gitignore': read('.gitignore'), 'a.txt': 'x\n' });
    commitAll(root, 'base');
    const ignored = (path: string): boolean => {
      try {
        gitIn(root, '-c', 'core.ignorecase=false', 'check-ignore', '-q', '--no-index', path);
        return true;
      } catch {
        return false;
      }
    };
    expect(['captures/x.jsonl', 'deep/normalized/x.txt'].map(ignored)).toEqual([true, true]);
    expect(['Captures/x.jsonl', 'NORMALIZED/x.txt', 'deep/Normalized/x.txt'].map(ignored)).toEqual([false, false, false]);
    // A case variant is staged by a plain `git add -A`, and a lower-case path by `git mv`, neither forced.
    mkdirSync(join(root, 'Captures'));
    writeFileSync(join(root, 'Captures', 'x.jsonl'), raw);
    gitIn(root, 'add', '-A');
    mkdirSync(join(root, 'captures'));
    gitIn(root, 'mv', 'a.txt', 'captures/a.txt');
    expect(trackedHygieneFiles(root)).toEqual(['Captures/x.jsonl', 'captures/a.txt']);
    for (const path of ['Captures/x.jsonl', 'captures/a.txt']) expect(classifyRepoPath(path, root)).toMatchObject({ ok: false, reason: expect.stringMatching(/under a captures\/ or normalized\/ directory/) });
  });

  it('lists normalize reports anywhere, in any letter case, and checks them against the closed report schema', () => {
    const root = newRepo({ [`evidence/${REPORT_NAME}`]: report(), 'evidence/B.NORMALIZE-REPORT.JSON': report((r) => (r.payload = '{"channel":"book"}')) });
    gitIn(root, 'add', '-A', '-f');
    expect(trackedHygieneFiles(root)).toEqual([`evidence/${REPORT_NAME}`, 'evidence/B.NORMALIZE-REPORT.JSON']);
    expect(classifyTrackedFile(`evidence/${REPORT_NAME}`, readRepoFile(`evidence/${REPORT_NAME}`, root))).toEqual({ ok: true, kind: 'normalize_report_v1' });
    expect(classifyTrackedFile('evidence/B.NORMALIZE-REPORT.JSON', readRepoFile('evidence/B.NORMALIZE-REPORT.JSON', root))).toMatchObject({ ok: false, reason: expect.stringMatching(/must NOT have additional properties/) });
  });

  it('checks every other tracked text file line by line for a raw capture record, whatever its extension', () => {
    const trade = JSON.stringify(captureExamples.message_trade);
    const root = newRepo({
      'fixtures/synthetic-baseline.jsonl': synthetic,
      'data.ndjson': raw,
      'notes/capture.txt': `a note\n  ${trade}  \n`,
      'dump.json': JSON.stringify(captureExamples.manifest_start) + '\n',
      'capture.jsonl.txt': raw,
      'README.md': `# fine\n${JSON.stringify(venueFrames.trade)}\n`,
      'blob.bin': Buffer.from([0xff, 0xfe, 0x00, 0x7b]),
    });
    gitIn(root, 'add', '-A');
    const verdicts = Object.fromEntries(trackedOtherFiles(root).map((path) => [path, classifyOtherPath(path, root)]));
    expect(verdicts).toEqual({
      'README.md': { ok: true, kind: 'other_text' },
      'blob.bin': { ok: true, kind: 'not_inspected' },
      'capture.jsonl.txt': { ok: false, reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' },
      'data.ndjson': { ok: false, reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' },
      'dump.json': { ok: false, reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' },
      'notes/capture.txt': { ok: false, reason: 'line 2 holds a raw capture record, in a file the fixture rules do not cover' },
    });
  });

  it('ends lines at CR LF, LF and CR, also tries the parts between VT, FF, NEL, U+2028 and U+2029, and trims control and format characters, marks and every character the non-blank rule counts as invisible, so none of them hides a record', () => {
    const record = JSON.stringify(captureExamples.message_trade);
    const found = (line: number) => ({ ok: false, reason: `line ${line} holds a raw capture record, in a file the fixture rules do not cover` });
    expect(classifyOtherFile(Buffer.from(`a note\r${record}\r`))).toEqual(found(2));
    expect(classifyOtherFile(Buffer.from(`a note\r\n${record}\r\n`))).toEqual(found(2));
    // A record set off by the further breaks alone is still found, as a part of its line.
    expect(classifyOtherFile(Buffer.from(`a note\u0085${record}`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`a note\u2028${record}\u2029after`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`a note\f${record}\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`a note\v${record}\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`a note\nmore\f${record}\n`))).toEqual(found(2));
    expect(classifyOtherFile(Buffer.from(`\u200b${record}\u2060\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`\ufeff${record}\n`))).toEqual(found(1));
    // Marks at either end (Unicode M: a combining grapheme joiner, a variation selector, combining acute, an enclosing
    // circle, a spacing mark), on a line and on a part of one; an object that is not a record still passes.
    for (const mark of ['\u034f', '\ufe0f', '\u0301', '\u20dd', '\u0903']) {
      expect(classifyOtherFile(Buffer.from(`${mark}${record}\n`)), mark).toEqual(found(1));
      expect(classifyOtherFile(Buffer.from(`${record}${mark}\n`)), mark).toEqual(found(1));
      expect(classifyOtherFile(Buffer.from(`a note\u2028${mark}${record}${mark}\u2029after\n`)), mark).toEqual(found(1));
    }
    expect(classifyOtherFile(Buffer.from('\u034f{"type":"not a record"}\ufe0f\n'))).toEqual({ ok: true, kind: 'other_text' });
    // Every other character the schemas' non-blank rule counts as invisible (fixture.v2 $defs/nonBlank), none of which is
    // Cc, Cf or M: the Hangul fillers and other default-ignorable letters, and the rule's listed exceptions.
    for (const blank of ['\u115f', '\u1160', '\u3164', '\uffa0', '\u2800', '\u303f', '\ufffc', '\u{13441}', '\u{13442}', '\u{1d159}']) {
      const name = `U+${blank.codePointAt(0)!.toString(16)}`;
      expect(classifyOtherFile(Buffer.from(`${blank}${record}${blank}\n`)), name).toEqual(found(1));
      expect(classifyOtherFile(Buffer.from(`a note\u2028${blank}${record}\u2029after\n`)), name).toEqual(found(1));
    }
    // The class is the non-blank rule's own: every code point its lookahead calls invisible is padding here.
    const invisible = /^\(\?!\[(.*)\]\)/u.exec(fixtureSchema.$defs.nonBlank.pattern)![1]!;
    const nonBlankInvisible = new RegExp(`^[${invisible}]$`, 'u');
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (nonBlankInvisible.test(ch) && !/^[\s\p{Cc}\p{Cf}\p{M}]$/u.test(ch)) {
        expect(classifyOtherFile(Buffer.from(`${ch}${record}\n`)), `U+${cp.toString(16)}`).toEqual(found(1));
      }
    }
    // An RFC 7464 JSON text sequence (each record after a record separator) and a C0 control prefix.
    expect(classifyOtherFile(Buffer.from(`\x1e${record}\n\x1e${record}\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`a note\n\x01${record}\x00\n`))).toEqual(found(2));
  });

  it('recognizes a raw capture record by its type alone or by its two clocks alone, as the contract says, and each of the other branch', () => {
    const found = { ok: false, reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' };
    // Every record type of the raw-record schema, with no clock fields: found by its type.
    for (const type of ['manifest_start', 'file_start', 'ws_open', 'ws_close', 'ws_error', 'subscribe', 'unsubscribe', 'ping', 'message', 'probe', 'note', 'file_end', 'manifest_end']) {
      expect(classifyOtherFile(Buffer.from(`${JSON.stringify({ type, data: 'x' })}\n`)), type).toEqual(found);
    }
    // Both receive clocks and no type, or a type the schema does not know: found by the clocks.
    expect(classifyOtherFile(Buffer.from('{"recvWallMs":1,"recvMonoNs":"2"}\n'))).toEqual(found);
    expect(classifyOtherFile(Buffer.from('{"type":"heartbeat","recvWallMs":1,"recvMonoNs":"2"}\n'))).toEqual(found);
    // One clock alone, or a type the schema does not know, is not a record.
    for (const text of ['{"recvWallMs":1}', '{"recvMonoNs":"2"}', '{"type":"heartbeat"}', '{"type":"MESSAGE"}']) {
      expect(classifyOtherFile(Buffer.from(`${text}\n`)), text).toEqual({ ok: true, kind: 'other_text' });
    }
  });

  it('finds a record written on one line whose string values hold NEL, U+2028 or U+2029, which JSON permits unescaped', () => {
    const found = (line: number) => ({ ok: false, reason: `line ${line} holds a raw capture record, in a file the fixture rules do not cover` });
    for (const separator of ['\u0085', '\u2028', '\u2029']) {
      const record = tradeWithBreak(separator);
      expect(record).toContain(separator);
      expect(JSON.parse(record)).toMatchObject({ type: 'message' });
      expect(classifyOtherFile(Buffer.from(`${record}\n`))).toEqual(found(1));
      expect(classifyOtherFile(Buffer.from(`a note\n${record}\n${record}\n`))).toEqual(found(2));
      expect(classifyOtherFile(Buffer.from(`${JSON.stringify({ ...captureExamples.note, detail: `a${separator}b${separator}c` })}\r\n`))).toEqual(found(1));
      // A record set off by two of these breaks inside other text is found as a part of its line, as before.
      expect(classifyOtherFile(Buffer.from(`{"comment":"x${separator}${JSON.stringify(captureExamples.message_trade)}${separator}y"}\n`))).toEqual(found(1));
      // Text that holds the character but no record passes.
      expect(classifyOtherFile(Buffer.from(`a note${separator}with a break\n{"type":"summary","text":"x${separator}y"}\n`))).toEqual({ ok: true, kind: 'other_text' });
    }
  });

  it('refuses a Git LFS pointer, whose content lives in the LFS store outside git, in the tree and in the history', () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 1048576\n';
    const reason = 'a Git LFS pointer, whose content lives in the LFS store outside git, where no layer reads it';
    expect(classifyOtherFile(Buffer.from(pointer))).toEqual({ ok: false, reason });
    expect(classifyOtherFile(Buffer.from(pointer.replace('git-lfs', 'hawser')))).toEqual({ ok: false, reason });
    expect(classifyOtherFile(Buffer.from('see version https://git-lfs.github.com/spec/v1 for the format\n'))).toEqual({ ok: true, kind: 'other_text' });
    // git-lfs trims white space before it decodes a pointer, so a pointer after leading white space is refused too; one
    // that is not on the first line is no pointer to git-lfs.
    for (const lead of [' ', '\t', '\n', '\r\n', ' \n\t', '\u00a0', '\u0085']) expect(classifyOtherFile(Buffer.from(lead + pointer)), JSON.stringify(lead)).toEqual({ ok: false, reason });
    expect(classifyOtherFile(Buffer.from(`not a pointer\n${pointer}`))).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherFile(Buffer.from(pointer.replace(/\n/g, '\r\n')))).toEqual({ ok: false, reason });
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(root, 'capture.bin'), pointer);
    const added = commitAll(root, 'track a capture through Git LFS');
    expect(classifyOtherPath('capture.bin', root)).toEqual({ ok: false, reason });
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([{ commit: added, path: 'capture.bin', reason }]);
  });

  it('refuses every pointer form git-lfs decodes: its three version URLs, white space, blank and ext lines, CRLF, bytes that are not UTF-8, a pointer padded past 1024 bytes', () => {
    // Each form is one git-lfs's own decoder (lfs/pointer.go DecodeFrom, commit 0043a64) takes for a pointer: run this
    // file with LFS_POINTER_FORMS_OUT set to a directory outside the repository and it writes every form there, one file
    // each, for that decoder to confirm.
    const reason = 'a Git LFS pointer, whose content lives in the LFS store outside git, where no layer reads it';
    const oid = `oid sha256:${'a'.repeat(64)}`;
    const ext = `ext-0-foo sha256:${'b'.repeat(64)}`;
    const body = (version: string, eol = '\n'): string => [`version ${version}`, oid, 'size 42'].join(eol) + eol;
    const canonical = body('https://git-lfs.github.com/spec/v1');
    const forms: Record<string, Buffer> = {
      canonical: Buffer.from(canonical),
      hawser: Buffer.from(body('https://hawser.github.com/spec/v1')),
      git_media_alpha: Buffer.from(body('http://git-media.io/v/2')),
      crlf: Buffer.from(body('https://git-lfs.github.com/spec/v1', '\r\n')),
      no_final_newline: Buffer.from(canonical.slice(0, -1)),
      blank_line_after_version: Buffer.from(canonical.replace('\n', '\n\n')),
      ext_before_version: Buffer.from(`${ext}\n${canonical}`),
      blank_line_after_ext: Buffer.from(`${ext}\n\n${canonical}`),
      crlf_blank_line_after_ext: Buffer.from(`${ext}\r\n\r\n${body('https://git-lfs.github.com/spec/v1', '\r\n')}`),
      ext_key_not_utf8: Buffer.concat([Buffer.from('ext-0-fo'), Buffer.from([0xff]), Buffer.from(` sha256:${'b'.repeat(64)}\n${canonical}`)]),
      padded_past_1024_bytes: Buffer.from(canonical + '\n'.repeat(2000)),
      ...Object.fromEntries(
        Object.entries({ lf: '\n', crlf: '\r\n', spaces: '   ', tab: '\t', vt_ff: '\v\f', nel: '\u0085', nbsp: '\u00a0', ideographic_space: '\u3000' }).map(([n, lead]) => [`leading_${n}`, Buffer.from(lead + canonical)]),
      ),
    };
    for (const [name, bytes] of Object.entries(forms)) expect(classifyOtherFile(bytes), name).toEqual({ ok: false, reason });
    // Near forms git-lfs rejects, refused all the same, since the check reads each line with the white space around it and
    // between its words trimmed and so fails closed on a file that only begins like a pointer.
    for (const [name, text] of Object.entries({
      trailing_space: canonical.replace('spec/v1\n', 'spec/v1 \n'),
      tab_separator: canonical.replace('version ', 'version\t'),
      indented_after_ext: `${ext}\n  ${canonical}`,
    })) expect(classifyOtherFile(Buffer.from(text)), name).toEqual({ ok: false, reason });
    // Not pointers to git-lfs, and not refused as one: the version line is not the first line that is neither blank nor an
    // extension, or the URL is not one git-lfs accepts.
    for (const text of [`not a pointer\n${canonical}`, 'see version https://git-lfs.github.com/spec/v1 for the format\n', body('https://git-lfs.github.com/spec/v2')]) {
      expect(classifyOtherFile(Buffer.from(text)), text).toEqual({ ok: true, kind: 'other_text' });
    }
    const out = process.env.LFS_POINTER_FORMS_OUT;
    if (out !== undefined) {
      const rel = relative(realpathSync(repoRootPath), realpathSync(dirname(out)));
      if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error(`LFS_POINTER_FORMS_OUT must be outside the repository: ${out}`);
      mkdirSync(out, { recursive: true });
      for (const [name, bytes] of Object.entries(forms)) writeFileSync(join(out, name), bytes);
    }
    // In the tree and in the history, which read the same check.
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'alpha.dat'), forms.git_media_alpha!);
    writeFileSync(join(root, 'padded.dat'), forms.padded_past_1024_bytes!);
    writeFileSync(join(root, 'ext.bin'), forms.ext_key_not_utf8!);
    const added = commitAll(root, 'pointers git-lfs decodes');
    for (const path of ['alpha.dat', 'padded.dat', 'ext.bin']) expect(classifyOtherPath(path, root), path).toEqual({ ok: false, reason });
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual(['alpha.dat', 'ext.bin', 'padded.dat'].map((path) => ({ commit: added, path, reason })));
  });

  it('reads every tracked entry outside the kinds or refuses it: a name that is not UTF-8, a skip-worktree entry, a file missing from disk, an unstaged change, an unreadable blob', () => {
    const record = JSON.stringify(captureExamples.message_trade) + '\n';
    const found = { ok: false, reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' };
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic, 'clean.txt': 'nothing here\n', 'edited.txt': 'nothing yet\n' });
    // Written through the file system by their bytes: one name that is not UTF-8 holding a record, one holding none; and
    // distinct bytes in each file, since the history scan reads each distinct blob once.
    writeFileSync(Buffer.from(`${root}/raw\xff.txt`, 'latin1'), `${record}raw\n`);
    writeFileSync(Buffer.from(`${root}/ok\xfe.txt`, 'latin1'), 'nothing here\n');
    writeFileSync(join(root, 'skipped.txt'), `${record}skipped\n`);
    writeFileSync(join(root, 'run.sh'), `${record}executable\n`, { mode: 0o755 });
    writeFileSync(join(root, 'deleted.txt'), `${record}deleted\n`);
    const base = commitAll(root, 'entries the working tree will not show by name');
    gitIn(root, 'update-index', '--skip-worktree', 'skipped.txt');
    rmSync(join(root, 'skipped.txt'));
    rmSync(join(root, 'deleted.txt'));
    writeFileSync(join(root, 'edited.txt'), record);
    const verdicts = Object.fromEntries(trackedOtherEntries(root).map((e) => [e.path, classifyOtherEntry(e, root)]));
    expect(verdicts).toEqual({
      'clean.txt': { ok: true, kind: 'other_text' },
      'deleted.txt': found,
      'edited.txt': found,
      'ok\\xfe.txt': { ok: true, kind: 'other_text' },
      'raw\\xff.txt': found,
      'run.sh': found,
      'skipped.txt': found,
    });
    expect(trackedOtherEntries(root).find((e) => e.path === 'run.sh')?.mode).toBe('100755');
    // Through the path-based interface too, which returned "not inspected" for these before.
    for (const path of ['skipped.txt', 'deleted.txt', 'edited.txt']) expect(classifyOtherPath(path, root), path).toEqual(found);
    expect(trackedOtherFiles(root)).toContain('raw\\xff.txt');
    // The history scan reads the same blobs by id, and names the entry without loss.
    expect(historyViolations(root, [base]).violations.map((v) => v.path).sort()).toEqual(['deleted.txt', 'raw\\xff.txt', 'run.sh', 'skipped.txt']);
    // A blob git cannot read is refused in the tree, never passed unread, and the history scan fails rather than skip it.
    const oid = gitIn(root, 'rev-parse', 'HEAD:clean.txt').trim();
    rmSync(join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    expect(classifyOtherPath('clean.txt', root)).toEqual({ ok: false, reason: 'a tracked entry whose blob git cannot read, so the content check cannot run' });
    expect(() => historyViolations(root, [base])).toThrow(/cannot read blob/);
  });

  it('refuses a path that is neither in the index nor on disk, and an index entry of a mode it does not read', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic, 'clean.txt': 'nothing here\n' });
    commitAll(root, 'base');
    expect(classifyOtherPath('nowhere.txt', root)).toEqual({ ok: false, reason: 'a path neither in the index nor present in the working tree' });
    const clean = trackedOtherEntries(root).find((e) => e.path === 'clean.txt')!;
    expect(classifyOtherEntry(clean, root)).toEqual({ ok: true, kind: 'other_text' });
    for (const mode of ['040000', '100664', '000000']) {
      expect(classifyOtherEntry({ ...clean, mode }, root), mode).toEqual({ ok: false, reason: `an index entry of mode ${mode}, which the rule does not read` });
    }
  });

  it('writes a name that is not UTF-8 with every high byte and every backslash escaped, so two such names never read alike', () => {
    const high = gitPathText(Buffer.from([0x61, 0xff, 0xfe]));
    const spelled = gitPathText(Buffer.from([0x61, 0x5c, 0x78, 0x66, 0x66, 0xfe]));
    expect(high).toEqual({ path: 'a\\xff\\xfe', utf8: false });
    expect(spelled).toEqual({ path: 'a\\x5cxff\\xfe', utf8: false });
    expect(gitPathText(Buffer.from('a\\b\u00e9', 'utf8'))).toEqual({ path: 'a\\b\u00e9', utf8: true });
  });

  it('refuses a covered path whose name is not UTF-8, in the tree and in the history, rather than reading it under another name', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    writeFileSync(Buffer.from(`${root}/fixtures/copy\xff.jsonl`, 'latin1'), synthetic);
    const added = commitAll(root, 'a synthetic fixture under a name that is not UTF-8');
    expect(trackedHygieneFiles(root)).toEqual(['fixtures/copy\\xff.jsonl', 'fixtures/synthetic-baseline.jsonl']);
    expect(classifyRepoPath('fixtures/copy\\xff.jsonl', root)).toMatchObject({ ok: false });
    expect(historyViolations(root, [added]).violations).toEqual([{ commit: added, path: 'fixtures/copy\\xff.jsonl', reason: 'a covered path whose name is not UTF-8, which the rule cannot read by name' }]);
  });

  it('checks a symbolic link\'s target text and refuses a submodule entry anywhere, in the tree and in the history', () => {
    const record = JSON.stringify(captureExamples.message_trade);
    const found = { ok: false, reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' };
    const submodule = { ok: false, reason: 'a submodule entry, whose content lives in another repository, where no layer reads it' };
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    symlinkSync(record, join(root, 'notes.txt'));
    symlinkSync('README.md', join(root, 'readme-link'));
    const added = commitAll(root, 'a link whose target is a raw record, and a harmless one');
    gitIn(root, 'update-index', '--add', '--cacheinfo', `160000,${base},vendor/data`);
    gitIn(root, 'commit', '-q', '-m', 'a submodule entry at a path no kind covers');
    const withSubmodule = gitIn(root, 'rev-parse', 'HEAD').trim();
    expect(trackedOtherFiles(root)).toEqual(expect.arrayContaining(['notes.txt', 'readme-link', 'vendor/data']));
    expect(classifyOtherPath('notes.txt', root)).toEqual(found);
    expect(classifyOtherPath('readme-link', root)).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherPath('vendor/data', root)).toEqual(submodule);
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: added, path: 'notes.txt', reason: found.reason },
      { commit: withSubmodule, path: 'vendor/data', reason: submodule.reason },
    ]);
  });

  it('finds a raw capture record block-quoted, after a trailer token, with a trailing comma or in a one-line JSON array', () => {
    const record = JSON.stringify(captureExamples.message_trade);
    const found = (line: number) => ({ ok: false, reason: `line ${line} holds a raw capture record, in a file the fixture rules do not cover` });
    expect(classifyOtherFile(Buffer.from(`${record},\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`[\n  ${record},\n  ${record}\n]\n`))).toEqual(found(2));
    expect(classifyOtherFile(Buffer.from(JSON.stringify([captureExamples.message_trade, captureExamples.message_book_update]) + '\n'))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`[${record}],\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`# notes\n\n> ${record}\n`))).toEqual(found(3));
    expect(classifyOtherFile(Buffer.from(`> > ${record}\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`> ${record}\n`))).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`${record} ,\n`))).toEqual(found(1));
    // Any white space after the trailer's colon, and padding before the record, as the other forms allow.
    for (const gap of ['  ', '\u00a0', '\u3000', ' \u200b', ' \u034f']) expect(classifyOtherFile(Buffer.from(`Raw-Record:${gap}${record}\n`)), JSON.stringify(gap)).toEqual(found(1));
    expect(classifyOtherFile(Buffer.from(`Subject\n\nBody.\n\nRaw-Record: ${record}\n`))).toEqual(found(5));
    // A quoted key, as in the constructed examples file, is not a trailer token: that form still passes.
    expect(classifyOtherFile(Buffer.from(`  "message_trade": ${record},\n`))).toEqual({ ok: true, kind: 'other_text' });
    // Disclosed collision (contract section 6.5): any object whose type is a raw record type is refused, a server-sent-events
    // sample included, so such a sample is written with its type changed.
    expect(classifyOtherFile(Buffer.from('event: ping\ndata: {"type":"ping"}\n'))).toEqual(found(2));
    expect(classifyOtherFile(Buffer.from('event: ping\ndata: {"type":"sse_ping"}\n'))).toEqual({ ok: true, kind: 'other_text' });
    // The same forms in commit messages, through the history scan.
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    const quoted = commitAll(root, `a quoted record\n\n> ${record}\n`);
    const trailer = commitAll(root, `a trailer\n\nRaw-Record: ${record}\n`);
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: quoted, path: '(commit message)', reason: 'line 3 of the commit message holds a raw capture record' },
      { commit: trailer, path: '(commit message)', reason: 'line 3 of the commit message holds a raw capture record' },
    ]);
  });

  it('takes linear time on long runs of padding inside a line, and walks deeply nested fixture values without overflowing', () => {
    // A trailing-run regex that could start anywhere in a run of padding took quadratic time (minutes for such a line).
    for (const pad of [' ', '\u200b', '\u0301']) {
      const started = performance.now();
      expect(classifyOtherFile(Buffer.from(`x${pad.repeat(200_000)}x\n`))).toEqual({ ok: true, kind: 'other_text' });
      expect(performance.now() - started, JSON.stringify(pad)).toBeLessThan(5_000);
    }
    // Built as text: 100000 nested arrays, which JSON.parse reads but a recursive walk (or JSON.stringify) cannot.
    const deep = (inner: string): string => recordedFixture(publishable, (h) => (h.extra = 'DEEP')).replace('"DEEP"', `${'['.repeat(100_000)}${inner}${']'.repeat(100_000)}`);
    expect(classifyJsonl(deep('"x"'))).toEqual({ ok: true, kind: 'recorded_v2_publishable' });
    expect(classifyJsonl(deep(JSON.stringify(captureExamples.message_trade)))).toEqual({
      ok: false,
      reason: 'non-blank line 1 carries a raw capture record nested under one of its keys',
    });
  });

  it('documents what the content check cannot see: a record over several lines, inside other text, or compressed', () => {
    // Disclosed limits (contract section 6.5), not guarantees: each of these passes the check.
    const record = captureExamples.message_trade!;
    expect(classifyOtherFile(Buffer.from(JSON.stringify(record, null, 2) + '\n'))).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherFile(Buffer.from(JSON.stringify([record, record], null, 2) + '\n'))).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherFile(Buffer.from(`const x = ${JSON.stringify(record)};\n`))).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherFile(Buffer.from(`| 1 | ${JSON.stringify(record)} |\n`))).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherFile(Buffer.from(JSON.stringify({ records: [record] }) + '\n'))).toEqual({ ok: true, kind: 'other_text' });
    expect(classifyOtherFile(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]))).toEqual({ ok: true, kind: 'not_inspected' });
  });

  it('fails on bytes that are not UTF-8 instead of decoding them to a replacement character', () => {
    const root = tempTree({ 'bad.jsonl': Buffer.concat([Buffer.from(synthetic.slice(0, 40)), Buffer.from([0x80, 0xbf, 0xff]), Buffer.from(synthetic.slice(40))]) });
    expect(() => readRepoFile('bad.jsonl', root)).toThrow();
    expect(classifyRepoPath('bad.jsonl', root)).toEqual({ ok: false, reason: 'bytes that are not UTF-8' });
  });

  it('keeps a leading byte order mark, so a BOM-prefixed fixture is not valid JSON and fails', () => {
    const root = tempTree({ 'bom.jsonl': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(synthetic)]) });
    const text = readRepoFile('bom.jsonl', root);
    expect(text.codePointAt(0)).toBe(0xfeff);
    expect(classifyJsonl(text)).toMatchObject({ ok: false, reason: expect.stringMatching(/line 1 is not valid JSON/) });
  });

  it('rejects a covered path that is a symbolic link, even to an allowed fixture, as the history scan does', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    symlinkSync('fixtures/synthetic-baseline.jsonl', join(root, 'link.jsonl'));
    gitIn(root, 'add', '-A');
    expect(trackedHygieneFiles(root)).toEqual(['fixtures/synthetic-baseline.jsonl', 'link.jsonl']);
    expect(classifyRepoPath('link.jsonl', root)).toMatchObject({ ok: false, reason: expect.stringMatching(/symbolic link/) });
    expect(classifyRepoPath('fixtures/synthetic-baseline.jsonl', root)).toEqual({ ok: true, kind: 'synthetic_v1' });
  });

  it('rejects a covered path that is a submodule entry, with or without its directory, as the history scan does', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    gitIn(root, 'update-index', '--add', '--cacheinfo', `160000,${base},sub.jsonl`);
    gitIn(root, 'update-index', '--add', '--cacheinfo', `160000,${base},sub2.jsonl`);
    mkdirSync(join(root, 'sub2.jsonl'));
    expect(trackedHygieneFiles(root)).toEqual(['fixtures/synthetic-baseline.jsonl', 'sub.jsonl', 'sub2.jsonl']);
    for (const p of ['sub.jsonl', 'sub2.jsonl']) expect(classifyRepoPath(p, root)).toMatchObject({ ok: false, reason: expect.stringMatching(/submodule entry/) });
    // Without .git (an exported archive) a directory at a covered path fails the same way, and a missing path fails.
    const archive = tempTree({ 'a.jsonl': synthetic });
    mkdirSync(join(archive, 'dir.jsonl'));
    expect(trackedHygieneFiles(archive)).toEqual(['a.jsonl', 'dir.jsonl']);
    expect(classifyRepoPath('dir.jsonl', archive)).toMatchObject({ ok: false, reason: expect.stringMatching(/submodule entry/) });
    expect(classifyRepoPath('gone.jsonl', archive)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing from the working tree/) });
  });

  it('fails rather than guesses when git cannot list the files of a git checkout', () => {
    const root = tempTree({ '.git': 'not a git directory', 'a.jsonl': synthetic });
    expect(() => trackedHygieneFiles(root)).toThrow(/cannot list the tracked files/);
  });

  it('without .git, scans the whole tree except the root dependency and output directories, the capture directories included', () => {
    const root = tempTree({
      'fixtures/a.jsonl': synthetic,
      'captures/cap-0.jsonl': raw,
      'captures/readme.txt': 'x',
      'CAPTURES/other.txt': 'x',
      'normalized/seg.jsonl': raw,
      'deep/out/raw.jsonl': raw,
      [`deep/${REPORT_NAME}`]: report(),
      'deep/captures/x.bin': raw,
      'node_modules/pkg/x.jsonl': raw,
      'out/baseline/steered.ledger.jsonl': raw,
      'dist/x.jsonl': raw,
    });
    expect(trackedHygieneFiles(root)).toEqual(['CAPTURES/other.txt', 'captures/cap-0.jsonl', 'captures/readme.txt', `deep/${REPORT_NAME}`, 'deep/captures/x.bin', 'deep/out/raw.jsonl', 'fixtures/a.jsonl', 'normalized/seg.jsonl']);
  });
});

describe('A10 history (every commit of a range, contract section 6.5)', () => {
  it('finds a raw capture added and deleted again inside the range, which the tree under test no longer shows', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'data.jsonl'), raw);
    const added = commitAll(root, 'add a raw capture');
    gitIn(root, 'rm', '-q', 'data.jsonl');
    commitAll(root, 'delete it again');
    expect(trackedHygieneFiles(root)).toEqual(['fixtures/synthetic-baseline.jsonl']);
    const scan = historyViolations(root, [`${base}..HEAD`]);
    expect(scan.commits).toBe(2);
    expect(scan.violations).toEqual([{ commit: added, path: 'data.jsonl', reason: expect.stringMatching(/raw capture record/) }]);
  });

  it('checks other files and commit messages too: a raw record in a .ndjson file added and deleted, and one pasted into a message', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'data.ndjson'), raw);
    const added = commitAll(root, 'add a raw capture under another name');
    gitIn(root, 'rm', '-q', 'data.ndjson');
    commitAll(root, 'delete it again');
    const pasted = commitAll(root, `a message\n\n${JSON.stringify(captureExamples.message_trade)}\n`);
    const scan = historyViolations(root, [`${base}..HEAD`]);
    expect(scan.commits).toBe(3);
    expect(scan.violations).toEqual([
      { commit: added, path: 'data.ndjson', reason: 'line 1 holds a raw capture record, in a file the fixture rules do not cover' },
      { commit: pasted, path: '(commit message)', reason: 'line 3 of the commit message holds a raw capture record' },
    ]);
  });

  it('finds a record whose string values hold U+2028, U+2029 or NEL in a file added and deleted, a commit message and a tag message', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'notes.txt'), `a note\n${tradeWithBreak('\u2028')}\n`);
    const added = commitAll(root, 'add a raw record whose payload holds a line separator');
    gitIn(root, 'rm', '-q', 'notes.txt');
    commitAll(root, 'delete it again');
    const pasted = commitAll(root, `a message\n\n${tradeWithBreak('\u2029')}\n`);
    gitIn(root, 'tag', '-a', '-m', `release\n${tradeWithBreak('\u0085')}`, 'v-sep');
    const tag = gitIn(root, 'rev-parse', 'v-sep').trim();
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: added, path: 'notes.txt', reason: 'line 2 holds a raw capture record, in a file the fixture rules do not cover' },
      { commit: pasted, path: '(commit message)', reason: 'line 3 of the commit message holds a raw capture record' },
    ]);
    expect(tagMessageViolations(root, tag)).toEqual([{ commit: tag, path: '(tag message)', reason: 'line 2 of the tag message holds a raw capture record' }]);
  });

  it('ignores replace refs, reading the objects a push sends: a raw commit hidden behind git replace is found', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    gitIn(root, 'checkout', '-q', '-b', 'side');
    const clean = commitAll(root, 'clean');
    gitIn(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'data.jsonl'), raw);
    const bad = commitAll(root, 'a raw capture');
    gitIn(root, 'replace', bad, clean);
    expect(historyViolations(root, [`${base}..main`]).violations).toEqual([{ commit: bad, path: 'data.jsonl', reason: expect.stringMatching(/raw capture record/) }]);
  });

  it('scans the side branch of a merge in the range, not only the first-parent line', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    gitIn(root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(root, 'data.jsonl'), raw);
    const bad = commitAll(root, 'a raw capture on the side branch');
    gitIn(root, 'rm', '-q', 'data.jsonl');
    commitAll(root, 'delete it again on the side branch');
    gitIn(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'other.txt'), 'main moves on\n');
    commitAll(root, 'main moves on');
    gitIn(root, ...['-c', 'user.name=a', '-c', 'user.email=a@example.invalid'], 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    expect(historyViolations(root, [`${base}..main`]).violations).toEqual([{ commit: bad, path: 'data.jsonl', reason: expect.stringMatching(/raw capture record/) }]);
  });

  it('exits 1 for a tag message that holds a raw record, 2 for a tag it cannot scan, and 0 for a clean one (the hook reads these codes)', () => {
    const root = newRepo({ 'README.md': 'x' });
    commitAll(root, 'base');
    gitIn(root, 'tag', '-a', '-m', `release\n${JSON.stringify(captureExamples.message_trade)}`, 'v-raw');
    gitIn(root, 'tag', '-a', '-m', 'a clean release', 'v-clean');
    const run = (...args: string[]): { status: number; stderr: string } => {
      try {
        execFileSync(TSX, [HISTORY_CLI, ...args], { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stderr: '' };
      } catch (e) {
        return { status: (e as { status: number }).status, stderr: (e as { stderr: string }).stderr };
      }
    };
    expect(run('--tag', gitIn(root, 'rev-parse', 'v-clean').trim()).status).toBe(0);
    expect(run('--tag', gitIn(root, 'rev-parse', 'v-raw').trim())).toMatchObject({ status: 1, stderr: expect.stringMatching(/A10 tag: .* \(tag message\): line 2 of the tag message holds a raw capture record/) });
    expect(run('--tag', 'f'.repeat(40))).toMatchObject({ status: 2, stderr: expect.stringMatching(/A10 tag: the tag could not be scanned/) });
    expect(run('--tag')).toMatchObject({ status: 2, stderr: expect.stringMatching(/give --tag <sha>; nothing was scanned/) });
  });

  it('runs the history scan in CI over every commit of the range, before the tests, from a full clone', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m);
    expect(ci).toMatch(/- uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0 /);
    expect(ci).toContain('          A10_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}\n          A10_HEAD: ${{ github.event.pull_request.head.sha || github.sha }}\n        run: npm run test:history -- --base "$A10_BASE" --head "$A10_HEAD"\n');
    expect(ci.indexOf('npm run test:history')).toBeGreaterThan(ci.indexOf('- run: npm ci'));
    expect(ci.indexOf('npm run test:history')).toBeLessThan(ci.indexOf('- run: npm test'));
    expect(ci).not.toMatch(/continue-on-error|if: /);
    expect(JSON.parse(read('package.json')).scripts['test:history']).toBe('tsx tests/a10-history-cli.ts');
  });

  it('reads the commit header as well as the message: a raw record in a mergetag header is found', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    const tree = gitIn(root, 'rev-parse', 'HEAD^{tree}').trim();
    const record = JSON.stringify(captureExamples.message_trade);
    const header = [`tree ${tree}`, `parent ${base}`, 'author a <a@example.invalid> 1791288000 +0000', 'committer a <a@example.invalid> 1791288000 +0000',
      `mergetag object ${base}`, ' type commit', ' tag signed', ' tagger a <a@example.invalid> 1791288000 +0000', ' ', ` ${record}`].join('\n');
    const commit = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, input: `${header}\n\nmerge side\n`, encoding: 'utf8', env: GIT_ENV }).trim();
    gitIn(root, 'update-ref', 'refs/heads/main', commit);
    expect(historyViolations(root, [`${base}..main`]).violations).toEqual([{ commit, path: '(commit header)', reason: 'line 10 of the commit header (a mergetag, for example) holds a raw capture record' }]);
  });

  it('reads the message of an annotated tag, and of a tag it points to, with the same content check', () => {
    const root = newRepo({ 'README.md': 'x' });
    commitAll(root, 'base');
    gitIn(root, 'tag', '-a', '-m', `inner\n${JSON.stringify(captureExamples.manifest_start)}`, 'inner');
    gitIn(root, 'tag', '-a', '-m', 'outer, clean', 'outer', 'inner');
    const outer = gitIn(root, 'rev-parse', 'outer').trim();
    const inner = gitIn(root, 'rev-parse', 'inner').trim();
    expect(tagMessageViolations(root, outer)).toEqual([{ commit: inner, path: '(tag message)', reason: 'line 2 of the tag message holds a raw capture record' }]);
    expect(tagMessageViolations(root, gitIn(root, 'rev-parse', 'HEAD').trim())).toEqual([]);
    expect(() => tagMessageViolations(root, 'f'.repeat(40))).toThrow(/cannot read tag object/);
  });

  it('names the commit that brought a disallowed file into the range, however many later commits keep it', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'data.jsonl'), raw);
    const added = commitAll(root, 'add a raw capture');
    writeFileSync(join(root, 'README.md'), 'y');
    commitAll(root, 'an unrelated change that keeps it');
    expect(historyViolations(root, [`${base}..HEAD`])).toEqual({ commits: 2, blobsChecked: 1, otherBlobsChecked: 2, violations: [{ commit: added, path: 'data.jsonl', reason: expect.stringMatching(/raw capture record/) }] });
  });

  it('finds any file that was force-added under captures/ or normalized/ in the range, binary files included', () => {
    const root = newRepo({ '.gitignore': 'captures/\nnormalized/\n' });
    const base = commitAll(root, 'base');
    mkdirSync(join(root, 'captures'));
    writeFileSync(join(root, 'captures', 'c-0.jsonl.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]));
    gitIn(root, 'add', '-f', 'captures/c-0.jsonl.gz');
    const added = commitAll(root, 'force-add a compressed capture');
    gitIn(root, 'rm', '-q', '-r', '--cached', 'captures');
    commitAll(root, 'untrack it');
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([{ commit: added, path: 'captures/c-0.jsonl.gz', reason: expect.stringMatching(/under a captures\/ or normalized\/ directory/) }]);
  });

  it('finds a normalize report that carried a value outside the closed schema in an earlier commit of the range', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, REPORT_NAME), report((r) => (r.dropped.depthWhileUnsynced.values = ['62710.4'])));
    const leaked = commitAll(root, 'report with values');
    writeFileSync(join(root, REPORT_NAME), report());
    commitAll(root, 'report fixed');
    const scan = historyViolations(root, [`${base}..HEAD`]);
    expect(scan.violations).toEqual([{ commit: leaked, path: REPORT_NAME, reason: expect.stringMatching(/additional properties/) }]);
  });

  it('scans exactly the commits the range names: an earlier deleted file is outside base..head, inside a full scan of head', () => {
    const root = newRepo({ 'old.jsonl': raw });
    const early = commitAll(root, 'a violation before the base');
    gitIn(root, 'rm', '-q', 'old.jsonl');
    const base = commitAll(root, 'deleted before the base');
    writeFileSync(join(root, 'fixture.jsonl'), synthetic);
    commitAll(root, 'a clean commit');
    expect(historyViolations(root, [`${base}..HEAD`])).toMatchObject({ commits: 1, blobsChecked: 1, violations: [] });
    expect(historyViolations(root, ['HEAD'])).toMatchObject({ commits: 3, blobsChecked: 2, violations: [{ commit: early, path: 'old.jsonl', reason: expect.stringMatching(/raw capture record/) }] });
  });

  it('scans each commit of the range whole, so a disallowed file the base already carries is reported with the first commit', () => {
    const root = newRepo({ 'old.jsonl': raw });
    const base = commitAll(root, 'a violation in the base');
    writeFileSync(join(root, 'fixture.jsonl'), synthetic);
    const first = commitAll(root, 'a clean commit on top');
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([{ commit: first, path: 'old.jsonl', reason: expect.stringMatching(/raw capture record/) }]);
  });

  it('checks each distinct (content, path) pair: a later bad version of a path, and identical bytes under a new path', () => {
    const root = newRepo({ [REPORT_NAME]: report() });
    const base = commitAll(root, 'a clean report in the base');
    writeFileSync(join(root, REPORT_NAME), report((r) => (r.dropped.depthWhileUnsynced.values = ['62710.4'])));
    const leaked = commitAll(root, 'a later version with values');
    writeFileSync(join(root, REPORT_NAME), report());
    commitAll(root, 'back to clean');
    writeFileSync(join(root, 'f.jsonl'), synthetic);
    commitAll(root, 'an allowed fixture');
    mkdirSync(join(root, 'captures'));
    writeFileSync(join(root, 'captures', 'f.jsonl'), synthetic);
    gitIn(root, 'add', '-f', 'captures/f.jsonl');
    const forced = commitAll(root, 'the same bytes under captures/');
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: leaked, path: REPORT_NAME, reason: expect.stringMatching(/additional properties/) },
      { commit: forced, path: 'captures/f.jsonl', reason: expect.stringMatching(/under a captures\/ or normalized\/ directory/) },
    ]);
  });

  it('decodes history as strictly as the tree: bytes that are not UTF-8 fail, and a kept byte order mark fails', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'bad.jsonl'), Buffer.concat([Buffer.from(synthetic.slice(0, 40)), Buffer.from([0x80, 0xbf, 0xff]), Buffer.from(synthetic.slice(40))]));
    writeFileSync(join(root, 'bom.jsonl'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(synthetic)]));
    const added = commitAll(root, 'two badly encoded fixtures');
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: added, path: 'bad.jsonl', reason: 'bytes that are not UTF-8' },
      { commit: added, path: 'bom.jsonl', reason: expect.stringMatching(/line 1 is not valid JSON/) },
    ]);
  });

  it('rejects a covered path that is a symbolic link or a submodule entry, and paths under upper-case capture directories', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const base = commitAll(root, 'base');
    symlinkSync('fixtures/synthetic-baseline.jsonl', join(root, 'link.jsonl'));
    gitIn(root, 'update-index', '--add', '--cacheinfo', `160000,${base},sub.jsonl`);
    mkdirSync(join(root, 'Normalized'));
    writeFileSync(join(root, 'Normalized', 'seg.txt'), 'x');
    gitIn(root, 'add', '-f', 'link.jsonl', 'Normalized/seg.txt');
    gitIn(root, 'commit', '-q', '-m', 'a link, a submodule entry and a force-added file');
    const added = gitIn(root, 'rev-parse', 'HEAD').trim();
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: added, path: 'Normalized/seg.txt', reason: expect.stringMatching(/under a captures\/ or normalized\/ directory/) },
      { commit: added, path: 'link.jsonl', reason: expect.stringMatching(/symbolic link/) },
      { commit: added, path: 'sub.jsonl', reason: expect.stringMatching(/submodule entry/) },
    ]);
  });

  it('fails rather than guesses when the range cannot be listed', () => {
    const root = newRepo({ 'README.md': 'x' });
    commitAll(root, 'base');
    expect(() => historyViolations(root, ['0123456789abcdef0123456789abcdef01234567..HEAD'])).toThrow(/cannot list the commits/);
  });

  it('fails the scan, not the file, when git cannot read a blob of the range', () => {
    const root = newRepo({ 'README.md': 'x' });
    commitAll(root, 'base');
    const tree = execFileSync('git', ['mktree', '--missing'], { cwd: root, encoding: 'utf8', env: GIT_ENV, input: `100644 blob ${'1'.repeat(40)}\tmissing.jsonl\n` }).trim();
    const commit = execFileSync('git', [...IDENTITY, 'commit-tree', tree, '-m', 'a tree with a missing blob'], { cwd: root, encoding: 'utf8', env: GIT_ENV }).trim();
    expect(() => historyViolations(root, [commit])).toThrow(/cannot read blob/);
  });

  it('the CLI of the CI step exits 1 on a violation in the range, 0 on a clean range and 2 when it cannot scan', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'data.jsonl'), raw);
    commitAll(root, 'add');
    gitIn(root, 'rm', '-q', 'data.jsonl');
    const head = commitAll(root, 'delete');
    const run = (...args: string[]): { status: number; out: string } => {
      try {
        return { status: 0, out: execFileSync(TSX, [HISTORY_CLI, ...args], { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (e) {
        const err = e as { status: number; stderr: string; stdout: string };
        return { status: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };
    expect(run('--base', base, '--head', head)).toMatchObject({ status: 1, out: expect.stringMatching(/data\.jsonl.*raw capture record/) });
    expect(run('--base', '0'.repeat(40), '--head', head)).toMatchObject({ status: 1, out: expect.stringMatching(/3 commits/) });
    expect(run('--base', '', '--head', head)).toMatchObject({ status: 1, out: expect.stringMatching(/3 commits/) });
    expect(run('--base', head, '--head', head)).toMatchObject({ status: 0, out: expect.stringMatching(/0 commits .*0 violations/) });
    expect(run('--base', base)).toMatchObject({ status: 2, out: expect.stringMatching(/nothing was scanned/) });
    // A base missing from the clone (the before of a force-push) widens the scan to everything reachable from head.
    expect(run('--base', '0123456789abcdef0123456789abcdef01234567', '--head', head)).toMatchObject({ status: 1, out: expect.stringMatching(/not in this clone[\s\S]*3 commits/) });
    expect(run('--base', base, '--head', '0123456789abcdef0123456789abcdef01234567')).toMatchObject({ status: 2, out: expect.stringMatching(/could not be scanned/) });
  });

  it('the CLI exits 2, not 1, when the repository rule itself cannot load (a broken schema)', () => {
    // A copy of the rule and its schemas, with the report schema broken; src and node_modules are the repository's own.
    const root = newRepo({ 'README.md': 'x' });
    const head = commitAll(root, 'base');
    const copy = tempDir();
    mkdirSync(join(copy, 'tests'));
    mkdirSync(join(copy, 'schemas'));
    for (const f of ['jsonl-policy.ts', 'a10-history-cli.ts']) copyFileSync(join(repoRootPath, 'tests', f), join(copy, 'tests', f));
    for (const f of ['capture-record.v1.schema.json', 'fixture.v2.schema.json']) copyFileSync(join(repoRootPath, 'schemas', f), join(copy, 'schemas', f));
    writeFileSync(join(copy, 'schemas', 'normalize-report.v1.schema.json'), JSON.stringify({ $id: 'x', type: 'object', unknownKeyword: true }));
    copyFileSync(join(repoRootPath, 'package.json'), join(copy, 'package.json'));
    symlinkSync(join(repoRootPath, 'src'), join(copy, 'src'));
    symlinkSync(join(repoRootPath, 'node_modules'), join(copy, 'node_modules'));
    let status = 0;
    let out = '';
    try {
      execFileSync(TSX, [join(copy, 'tests', 'a10-history-cli.ts'), '--base', '', '--head', head], { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      status = err.status;
      out = err.stderr;
    }
    expect(status).toBe(2);
    expect(out).toMatch(/could not be scanned/);
  });
});

describe('A10 opt-in pre-push hook (.githooks/pre-push, contract section 6.5)', () => {
  /** A clone opted in through core.hooksPath, with a bare remote; its node_modules and tests are the repository's own, untracked. */
  const hookClone = (withNodeModules = true): { root: string; remote: string; hookGit: (...args: string[]) => string; push: (...args: string[]) => string } => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const remote = tempDir();
    execFileSync('git', ['init', '-q', '--bare', remote], { env: GIT_ENV, stdio: 'ignore' });
    mkdirSync(join(root, '.githooks'));
    copyFileSync(join(repoRootPath, '.githooks', 'pre-push'), join(root, '.githooks', 'pre-push'));
    if (withNodeModules) symlinkSync(join(repoRootPath, 'node_modules'), join(root, 'node_modules'));
    symlinkSync(join(repoRootPath, 'tests'), join(root, 'tests'));
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'node_modules\ntests\n');
    const hookGit = (...args: string[]): string => execFileSync('git', [...IDENTITY, ...args], { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    hookGit('config', 'core.hooksPath', '.githooks');
    hookGit('remote', 'add', 'origin', remote);
    hookGit('add', '-A');
    hookGit('commit', '-q', '-m', 'base');
    /** Pushes and returns the hook's stderr when the push is refused, or '' when it goes through. */
    const push = (...args: string[]): string => {
      try {
        hookGit('push', '-q', ...args);
        return '';
      } catch (e) {
        return (e as { stderr: string }).stderr;
      }
    };
    return { root, remote, hookGit, push };
  };
  const remoteRef = (remote: string, ref: string): string | undefined => {
    try {
      return execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8', env: GIT_ENV }).trim();
    } catch {
      return undefined;
    }
  };
  const addAndDeleteRaw = (c: ReturnType<typeof hookClone>): void => {
    writeFileSync(join(c.root, 'data.jsonl'), raw);
    c.hookGit('add', '-A');
    c.hookGit('commit', '-q', '-m', 'add a raw capture');
    c.hookGit('rm', '-q', 'data.jsonl');
    c.hookGit('commit', '-q', '-m', 'delete it again');
  };

  it('refuses an update push whose new commits carried a raw capture added and deleted again, and --no-verify bypasses it', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    const base = remoteRef(c.remote, 'main');
    addAndDeleteRaw(c);
    const refused = c.push('origin', 'main');
    expect(refused).toMatch(/A10 history: .*"data\.jsonl": non-blank line 1 is a raw capture record/);
    expect(refused).toMatch(/A10 pre-push: refusing the push of refs\/heads\/main;/);
    expect(remoteRef(c.remote, 'main')).toBe(base);
    // The documented limit: the hook is a local control, and --no-verify skips it.
    expect(c.push('--no-verify', 'origin', 'main')).toBe('');
    expect(remoteRef(c.remote, 'main')).toBe(c.hookGit('rev-parse', 'HEAD').trim());
  });

  it('scans everything reachable when the remote value is not in the clone (a force-push after a rewrite)', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    const base = c.hookGit('rev-parse', 'HEAD').trim();
    writeFileSync(join(c.root, 'extra.txt'), 'x');
    c.hookGit('add', '-A');
    c.hookGit('commit', '-q', '-m', 'a commit only the remote will keep');
    expect(c.push('origin', 'main')).toBe('');
    // Rewrite main locally and prune the old tip, so the remote's value is unknown to this clone.
    c.hookGit('reset', '-q', '--hard', base);
    c.hookGit('update-ref', '-d', 'refs/remotes/origin/main');
    c.hookGit('reflog', 'expire', '--expire=now', '--all');
    c.hookGit('gc', '-q', '--prune=now');
    writeFileSync(join(c.root, 'clean.txt'), 'y');
    c.hookGit('add', '-A');
    c.hookGit('commit', '-q', '-m', 'the rewritten, clean history');
    expect(c.push('--force', 'origin', 'main')).toBe('');
    expect(remoteRef(c.remote, 'main')).toBe(c.hookGit('rev-parse', 'HEAD').trim());
    // The same situation with a raw capture added and deleted in the rewritten history is refused.
    const pushed = c.hookGit('rev-parse', 'HEAD').trim();
    c.hookGit('reset', '-q', '--hard', base);
    c.hookGit('update-ref', '-d', 'refs/remotes/origin/main');
    c.hookGit('reflog', 'expire', '--expire=now', '--all');
    c.hookGit('gc', '-q', '--prune=now');
    addAndDeleteRaw(c);
    const refused = c.push('--force', 'origin', 'main');
    expect(refused).toMatch(/is not in this clone; scanning every commit reachable[\s\S]*"data\.jsonl": non-blank line 1 is a raw capture record[\s\S]*refusing the push of refs\/heads\/main;/);
    expect(remoteRef(c.remote, 'main')).toBe(pushed);
  });

  it('refuses to push a tag that points at a blob or a tree, whose files no commit scan sees', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: c.root, encoding: 'utf8', env: GIT_ENV, input: raw }).trim();
    c.hookGit('tag', 'raw-blob', blob);
    expect(c.push('origin', 'refs/tags/raw-blob')).toMatch(/refs\/tags\/raw-blob does not point at a commit[\s\S]*refusing the push of refs\/tags\/raw-blob;/);
    expect(remoteRef(c.remote, 'refs/tags/raw-blob')).toBeUndefined();
    const tree = c.hookGit('rev-parse', 'HEAD^{tree}').trim();
    c.hookGit('tag', '-a', '-m', 'a tree', 'a-tree', tree);
    expect(c.push('origin', 'refs/tags/a-tree')).toMatch(/does not point at a commit/);
  });

  it('refuses the first push of a new branch that carried a raw capture, the usual way a pull request branch is published', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    c.hookGit('checkout', '-q', '-b', 'feature');
    addAndDeleteRaw(c);
    expect(c.push('origin', 'feature')).toMatch(/"data\.jsonl": non-blank line 1 is a raw capture record[\s\S]*refusing the push of refs\/heads\/feature;/);
    expect(remoteRef(c.remote, 'feature')).toBeUndefined();
  });

  it('does not trust a stale remote-tracking ref: a new branch reusing a raw commit the remote no longer has is refused', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    c.hookGit('checkout', '-q', '-b', 'b');
    addAndDeleteRaw(c);
    expect(c.push('--no-verify', 'origin', 'b')).toBe('');
    // The owner deletes the branch on the server; this clone still has origin/b pointing at the raw commits.
    execFileSync('git', ['--git-dir', c.remote, 'update-ref', '-d', 'refs/heads/b'], { env: GIT_ENV });
    execFileSync('git', ['--git-dir', c.remote, 'reflog', 'expire', '--expire=now', '--all'], { env: GIT_ENV });
    execFileSync('git', ['--git-dir', c.remote, 'gc', '-q', '--prune=now'], { env: GIT_ENV });
    expect(c.hookGit('branch', '-r')).toMatch(/origin\/b/);
    c.hookGit('checkout', '-q', '-b', 'c');
    expect(c.push('origin', 'c')).toMatch(/"data\.jsonl": non-blank line 1 is a raw capture record/);
    expect(remoteRef(c.remote, 'c')).toBeUndefined();
  });

  it('installed in .git/hooks as the contract recommends, refuses a push from a checkout without the scan', () => {
    const c = hookClone();
    c.hookGit('config', '--unset', 'core.hooksPath');
    copyFileSync(join(c.root, '.githooks', 'pre-push'), join(c.root, '.git', 'hooks', 'pre-push'));
    chmodSync(join(c.root, '.git', 'hooks', 'pre-push'), 0o755);
    // An older checkout: no scan in the working tree.
    rmSync(join(c.root, 'tests'));
    expect(c.push('origin', 'main')).toMatch(/A10 pre-push: this checkout has no tests\/a10-history-cli\.ts or tests\/jsonl-policy\.ts/);
    expect(remoteRef(c.remote, 'main')).toBeUndefined();
  });

  it('documents the core.hooksPath limit: on a checkout without .githooks/pre-push nothing runs, where the .git/hooks copy refuses', () => {
    const c = hookClone();
    c.hookGit('rm', '-q', '.githooks/pre-push');
    c.hookGit('commit', '-q', '-m', 'a tree without the hook, as on main before the rule');
    addAndDeleteRaw(c);
    const head = c.hookGit('rev-parse', 'HEAD').trim();
    // core.hooksPath=.githooks: there is no hook in this checkout, and the push goes through unscanned.
    c.hookGit('push', '-q', 'origin', `${head}:refs/heads/unscanned`);
    expect(remoteRef(c.remote, 'unscanned')).toBe(head);
    // The copy in .git/hooks still runs, and the scan (here still in the working tree) refuses the same commits.
    c.hookGit('config', '--unset', 'core.hooksPath');
    mkdirSync(join(c.root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(c.root, '.git', 'hooks', 'pre-push'), read('.githooks/pre-push'), { mode: 0o755 });
    expect(c.push('origin', 'main')).toMatch(/"data\.jsonl": non-blank line 1 is a raw capture record/);
    expect(remoteRef(c.remote, 'main')).toBeUndefined();
  });

  it('reads the tag a push sends, not a replacement: an annotated tag whose message is a raw record, replaced by a commit, is refused', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    c.hookGit('tag', '-a', '-m', `release\n\n${JSON.stringify(captureExamples.message_trade)}`, 'v-hidden');
    const tag = c.hookGit('rev-parse', 'v-hidden').trim();
    // Replaced by a commit, the tag reads as that commit to every git command that honours replace refs, so a hook that
    // honoured them would take it for a lightweight tag and never read its message.
    c.hookGit('replace', '-f', tag, c.hookGit('rev-parse', 'HEAD').trim());
    expect(c.hookGit('cat-file', '-t', tag).trim()).toBe('commit');
    expect(c.push('origin', 'refs/tags/v-hidden')).toMatch(/\(tag message\): line 3 of the tag message holds a raw capture record[\s\S]*refusing the push of refs\/tags\/v-hidden;/);
    expect(remoteRef(c.remote, 'refs/tags/v-hidden')).toBeUndefined();
  });

  it('installs executable by the documented command, also over an existing copy that is not, which git would skip', () => {
    const c = hookClone();
    c.hookGit('config', '--unset', 'core.hooksPath');
    const hooks = c.hookGit('rev-parse', '--git-path', 'hooks').trim();
    const installed = join(c.root, hooks, 'pre-push');
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, 'stale\n', { mode: 0o644 });
    chmodSync(installed, 0o644);
    const install = /^cp \.githooks\/pre-push "\$\(git rev-parse --git-path hooks\)\/pre-push" && chmod \+x "\$\(git rev-parse --git-path hooks\)\/pre-push"(?=   #)/m.exec(read('README.md'))![0];
    for (const text of [read('.githooks/pre-push'), read('docs/M2_DATA_CONTRACT.md'), read('docs/M2_GROK_HANDOFF.md')]) expect(text).toContain(install);
    execFileSync('sh', ['-c', install], { cwd: c.root, env: GIT_ENV });
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(readRepoFile('.git/hooks/pre-push', c.root)).toEqual(readRepoFile('.githooks/pre-push', c.root));
    // What the owner checks before a capture includes that the copy is executable (contract section 6.5, handoff A12).
    for (const text of [read('docs/M2_DATA_CONTRACT.md'), read('docs/M2_GROK_HANDOFF.md')]) expect(text).toContain('test -x "$(git rev-parse --git-path hooks)/pre-push"');
  });

  it('refuses to push an annotated tag whose message is a raw capture record, and a git notes ref whose note is one', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    const record = JSON.stringify(captureExamples.message_trade);
    c.hookGit('tag', '-a', '-m', `release\n\n${record}`, 'v-raw');
    expect(c.push('origin', 'refs/tags/v-raw')).toMatch(/\(tag message\): line 3 of the tag message holds a raw capture record/);
    expect(remoteRef(c.remote, 'refs/tags/v-raw')).toBeUndefined();
    c.hookGit('tag', '-a', '-m', 'a clean release', 'v-clean');
    expect(c.push('origin', 'refs/tags/v-clean')).toBe('');
    c.hookGit('notes', 'add', '-m', record, 'HEAD');
    expect(c.push('origin', 'refs/notes/commits')).toMatch(/line 1 holds a raw capture record, in a file the fixture rules do not cover/);
    expect(remoteRef(c.remote, 'refs/notes/commits')).toBeUndefined();
  });

  it('refuses a push whose commits carried a record whose string values hold U+2028, and a tag whose message is one', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    const record = tradeWithBreak('\u2028');
    c.hookGit('checkout', '-q', '-b', 'feature');
    writeFileSync(join(c.root, 'export.txt'), `${record}\n`);
    c.hookGit('add', '-A');
    c.hookGit('commit', '-q', '-m', 'an export');
    c.hookGit('rm', '-q', 'export.txt');
    c.hookGit('commit', '-q', '-m', 'delete it again');
    expect(c.push('origin', 'feature')).toMatch(/"export\.txt": line 1 holds a raw capture record[\s\S]*refusing the push of refs\/heads\/feature;/);
    expect(remoteRef(c.remote, 'feature')).toBeUndefined();
    c.hookGit('checkout', '-q', 'main');
    c.hookGit('tag', '-a', '-m', `release\n${record}`, 'v-sep');
    expect(c.push('origin', 'refs/tags/v-sep')).toMatch(/\(tag message\): line 2 of the tag message holds a raw capture record/);
    expect(remoteRef(c.remote, 'refs/tags/v-sep')).toBeUndefined();
  });

  it('documents the limit: it enforces the rule as the working tree has it, so an uncommitted edit lets a raw capture through while the cmp check passes, and only the git status check shows it', () => {
    const root = newRepo({ 'fixtures/synthetic-baseline.jsonl': synthetic });
    const remote = tempDir();
    execFileSync('git', ['init', '-q', '--bare', remote], { env: GIT_ENV, stdio: 'ignore' });
    mkdirSync(join(root, '.githooks'));
    copyFileSync(join(repoRootPath, '.githooks', 'pre-push'), join(root, '.githooks', 'pre-push'));
    mkdirSync(join(root, 'tests'));
    for (const f of ['jsonl-policy.ts', 'a10-history-cli.ts']) copyFileSync(join(repoRootPath, 'tests', f), join(root, 'tests', f));
    for (const p of ['node_modules', 'src', 'schemas', 'package.json']) symlinkSync(join(repoRootPath, p), join(root, p));
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'node_modules\nsrc\nschemas\npackage.json\n');
    gitIn(root, 'remote', 'add', 'origin', remote);
    commitAll(root, 'base, with the rule and the scan committed');
    const installed = join(root, '.git', 'hooks', 'pre-push');
    mkdirSync(dirname(installed), { recursive: true });
    copyFileSync(join(root, '.githooks', 'pre-push'), installed);
    chmodSync(installed, 0o755);
    const push = (ref: string): string => {
      try {
        execFileSync('git', [...IDENTITY, 'push', '-q', 'origin', ref], { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        return '';
      } catch (e) {
        return (e as { stderr: string }).stderr;
      }
    };
    const ownerChecks = (): { cmp: boolean; status: string } => ({
      cmp: readRepoFile('.githooks/pre-push', root) === readRepoFile('.git/hooks/pre-push', root),
      status: gitIn(root, 'status', '--porcelain'),
    });
    expect(push('main')).toBe('');
    gitIn(root, 'checkout', '-q', '-b', 'raw');
    writeFileSync(join(root, 'session.ndjson'), raw);
    commitAll(root, 'a raw capture under another name');
    expect(push('raw')).toMatch(/"session\.ndjson": line 1 holds a raw capture record/);
    const rule = readRepoFile('tests/jsonl-policy.ts', root);
    const opening = 'function isRawCaptureRecord(v: Record<string, any>): boolean {\n';
    expect(rule).toContain(opening);
    writeFileSync(join(root, 'tests', 'jsonl-policy.ts'), rule.replace(opening, `${opening}  return false;\n`));
    expect(ownerChecks()).toEqual({ cmp: true, status: ' M tests/jsonl-policy.ts\n' });
    expect(push('raw')).toBe('');
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'refs/heads/raw'], { encoding: 'utf8', env: GIT_ENV }).trim()).toBe(gitIn(root, 'rev-parse', 'HEAD').trim());
  });

  it('refuses the push while an installed copy differs from the checkout\'s .githooks/pre-push, so a strengthened hook is not left behind', () => {
    const c = hookClone();
    c.hookGit('config', '--unset', 'core.hooksPath');
    writeFileSync(join(c.root, '.git', 'hooks', 'pre-push'), read('.githooks/pre-push').replace('#!/bin/sh\n', '#!/bin/sh\n# an older copy\n'), { mode: 0o755 });
    expect(c.push('origin', 'main')).toMatch(/A10 pre-push: this hook \(.*\) differs from the checkout's \.githooks\/pre-push/);
    expect(remoteRef(c.remote, 'main')).toBeUndefined();
    copyFileSync(join(c.root, '.githooks', 'pre-push'), join(c.root, '.git', 'hooks', 'pre-push'));
    expect(c.push('origin', 'main')).toBe('');
  });

  it('reads the objects the push sends, not replacements: a raw commit hidden behind git replace is still refused', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    // A clean sibling commit on another branch, then the raw commit on main, replaced locally by the clean one.
    c.hookGit('checkout', '-q', '-b', 'side');
    c.hookGit('commit', '-q', '--allow-empty', '-m', 'clean');
    const clean = c.hookGit('rev-parse', 'HEAD').trim();
    c.hookGit('checkout', '-q', 'main');
    writeFileSync(join(c.root, 'data.jsonl'), raw);
    c.hookGit('add', '-A');
    c.hookGit('commit', '-q', '-m', 'a raw capture');
    const bad = c.hookGit('rev-parse', 'HEAD').trim();
    c.hookGit('replace', bad, clean);
    expect(c.push('origin', 'main')).toMatch(/"data\.jsonl": non-blank line 1 is a raw capture record/);
    expect(remoteRef(c.remote, 'main')).not.toBe(bad);
  });

  it('refuses to push an annotated tag whose header carries a raw capture record (a tag object written with hash-object --literally)', () => {
    const c = hookClone();
    expect(c.push('origin', 'main')).toBe('');
    const head = c.hookGit('rev-parse', 'HEAD').trim();
    const text = [`object ${head}`, 'type commit', 'tag odd', 'tagger a <a@example.invalid> 1791288000 +0000', JSON.stringify(captureExamples.message_trade), '', 'a message', ''].join('\n');
    const tag = execFileSync('git', ['hash-object', '-t', 'tag', '-w', '--literally', '--stdin'], { cwd: c.root, input: text, encoding: 'utf8', env: GIT_ENV }).trim();
    c.hookGit('update-ref', 'refs/tags/odd', tag);
    expect(c.push('origin', 'refs/tags/odd')).toMatch(/\(tag header\): line 5 of the tag header holds a raw capture record/);
    expect(remoteRef(c.remote, 'refs/tags/odd')).toBeUndefined();
  });

  it('refuses the push when it cannot run (no node_modules), rather than letting it through', () => {
    const c = hookClone(false);
    expect(c.push('origin', 'main')).toMatch(/A10 pre-push: node_modules\/\.bin\/tsx is missing/);
    expect(remoteRef(c.remote, 'main')).toBeUndefined();
  });
});

describe('A10 classifier', () => {
  it('accepts the engine\'s version-1 synthetic fixture format', () => {
    expect(classifyJsonl(synthetic)).toEqual({ ok: true, kind: 'synthetic_v1' });
  });

  it('checks a normalize report against the closed report schema, as one JSON document', () => {
    expect(classifyNormalizeReport(report())).toEqual({ ok: true, kind: 'normalize_report_v1' });
    expect(classifyNormalizeReport(report((r) => (r.segments[0].detail = 'checksum expected 1234567890, received 987654321')))).toMatchObject({ ok: false, reason: expect.stringMatching(/must NOT have additional properties/) });
    expect(classifyNormalizeReport(report((r) => (r.counts['records.message'] = 62710.4)))).toMatchObject({ ok: false, reason: expect.stringMatching(/must be integer/) });
    expect(classifyNormalizeReport('{"reportFormatVersion":')).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid JSON/) });
    expect(classifyNormalizeReport(jsonl([reportExamples.report_segments, reportExamples.report_no_fixture]))).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid JSON/) });
  });

  it('requires a normalize report to be exactly its canonical bytes, so a shadowed duplicate key or a free layout carries nothing', () => {
    const smuggled = '{"cuts":[{"detail":"crossed at 62710.4","raw":{"channel":"book","data":[{"bids":[{"price":62710.4,"qty":0.25}]}]}}],' + report().slice(1);
    expect(classifyNormalizeReport(smuggled)).toMatchObject({ ok: false, reason: expect.stringMatching(/not its canonical serialization/) });
    expect(classifyNormalizeReport(JSON.stringify(reportExamples.report_segments, null, 7) + '\n')).toMatchObject({ ok: false, reason: expect.stringMatching(/not its canonical serialization/) });
    expect(classifyNormalizeReport(report().trimEnd())).toMatchObject({ ok: false, reason: expect.stringMatching(/not its canonical serialization/) });
    expect(classifyNormalizeReport(canonicalReport(reportExamples.report_r1_unsupported_version))).toEqual({ ok: true, kind: 'normalize_report_v1' });
  });

  it('requires sorted keys, so the order of keys carries nothing either', () => {
    // The example file keeps a readable key order; serialized as it stands, that order is not the canonical one.
    expect(classifyNormalizeReport(JSON.stringify(reportExamples.report_segments, null, 2) + '\n')).toMatchObject({ ok: false, reason: expect.stringMatching(/not its canonical serialization/) });
    const dropped = Object.keys(reportExamples.report_segments!.dropped);
    expect(dropped).not.toEqual([...dropped].sort());
  });

  it.each<[string, (r: Json) => void, RegExp]>([
    ['raw files out of order', (r) => r.rawFiles.reverse(), /rawFiles not numbered/],
    ['segments out of order', (r) => r.segments.reverse(), /segments not numbered/],
    ['a segment index skipped', (r) => (r.segments[2].segmentIndex = 3), /segments not numbered/],
    ['a fixture file named for another segment', (r) => (r.segments[0].fixtureFile = `${r.captureId}-seg7.jsonl`), /fixtureFile does not name its own capture and segment/],
    ['a fixture file named for another capture', (r) => (r.segments[0].fixtureFile = '00000000-0000-4000-8000-000000000000-seg0.jsonl'), /fixtureFile does not name its own capture and segment/],
    ['cuts out of order', (r) => r.cuts.reverse(), /cuts not in strictly ascending/],
    ['a dropped record listed twice', (r) => r.dropped.depthWhileUnsynced.records.splice(1, 0, { fileIndex: 1, record: 41005 }), /dropped\.depthWhileUnsynced\.records not in strictly ascending/],
    ['dropped records out of order', (r) => r.dropped.depthBeforeSnapshot.records.reverse(), /dropped\.depthBeforeSnapshot\.records not in strictly ascending/],
    ['more dropped records than the count', (r) => (r.dropped.offLotSize.count = 0), /dropped\.offLotSize lists more records than its count/],
    ['rejections out of order', (r) => r.rejections.reverse(), /rejections not in strictly ascending order/],
    ['a rejection listed twice', (r) => r.rejections.push(structuredClone(r.rejections[3])), /rejections not in strictly ascending order/],
    ['supersedes out of order', (r) => (r.supersedes = [1, 0].map((segmentIndex) => ({ segmentIndex, fixtureSha256: 'd'.repeat(64), normalizerVersion: '0.1.0', normalizerCommit: '89abcde', adapterVersion: '1' }))), /supersedes not in strictly ascending/],
  ])('rejects a schema-valid report with %s (the order and naming rules; they narrow, not close, what a report can encode)', (_name, change, reason) => {
    expect(classifyNormalizeReport(report(change))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('accepts one frame carrying two off-lot trade items as count 2, one record reference and one rejection', () => {
    expect(classifyNormalizeReport(report((r) => (r.dropped.offLotSize.count = 2)))).toEqual({ ok: true, kind: 'normalize_report_v1' });
  });

  it.each<[string, (r: Json) => void, RegExp]>([
    ['a socket rule reported with segment scope', (r) => (r.rejections[3].scope = 'segment'), /rule R9 with scope segment, not socket/],
    ['an item rule naming the rights field', (r) => (r.rejections[2].field = 'rights'), /rule R4 naming field rights/],
    ['a socket rule tied to a segment', (r) => (r.rejections[3].segmentIndex = 2), /rule R9 with scope socket and segmentIndex 2/],
    ['a segment rejection its segment does not name', (r) => (r.rejections[1].rule = 'R6'), /rule R6 for segment 2, which that segment does not name/],
    ['a too_short segment under another rule', (r) => { r.segments[1].rule = 'R2'; r.rejections[0].rule = 'R2'; }, /segment 1 too_short under R2, not R7/],
    ['a refused segment under R7', (r) => { r.segments[2].rule = 'R7'; r.rejections[1].rule = 'R7'; }, /segment 2 refused under R7/],
    ['a cut listed as an R3 rejection', (r) => r.rejections.splice(2, 0, { rule: 'R3', scope: 'segment', segmentIndex: 0, at: { fileIndex: 0, record: 70000 }, field: null }), /rule R3, a cut, listed as a rejection/],
  ])('rejects a schema-valid report with %s (the rule pairings; the choice among allowed codes stays open)', (_name, change, reason) => {
    expect(classifyNormalizeReport(report(change))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  const r4At = (r: Json): Json => r.rejections.find((j: Json) => j.rule === 'R4');
  it.each<[string, (r: Json) => void, RegExp]>([
    ['a count too large to be a safe integer', (r) => (r.options.windowMs = 6.27104e25), /not a safe integer/],
    ['a record reference beyond the raw files it lists', (r) => (r.cuts[1].at = { fileIndex: 7, record: 1 }), /7:1 outside the raw files the report lists/],
    ['a record reference more than one record past a file\'s file_end', (r) => (r.dropped.depthBeforeSnapshot.records[1].record = 120002), /0:120002 outside the raw files/],
    ['a segment that starts after its end', (r) => (r.segments[1].start = { fileIndex: 1, record: 41300 }), /segment 1 starts after its end/],
    ['overlapping segments', (r) => (r.segments[1].start = { fileIndex: 1, record: 40000 }), /segment 1 does not start after segment 0 ends/],
    ['a start reason that does not follow the previous end reason', (r) => (r.segments[1].startReason = 'resync_after_clock_cut'), /segment 1 starts with resync_after_clock_cut, not resync_after_gap/],
    ['a first segment that does not start with capture_start', (r) => (r.segments[0].startReason = 'resync_after_gap'), /segment 0 starts with resync_after_gap, not capture_start/],
    ['capture_end on a segment that is not the last', (r) => { r.segments[0].endReason = 'capture_end'; r.cuts.shift(); }, /segment 0 ends with capture_end but is not the last/],
    ['a refused segment with no rejection', (r) => r.rejections.splice(1, 1), /segment 2 \(refused\) with 0 segment rejections/],
    ['a cut for a segment the report does not list', (r) => (r.cuts[1].segmentIndex = 9), /a cut for segment 9/],
    ['a cut whose reason is not its segment\'s end reason', (r) => (r.cuts[0].reason = 'clock_cut'), /a cut clock_cut for segment 0, which ends with checksum_mismatch/],
    ['a cut that is not after its segment\'s end', (r) => (r.cuts[0].at = { fileIndex: 1, record: 40999 }), /not after its end/],
    ['two cuts for one segment', (r) => r.cuts.splice(1, 0, { segmentIndex: 0, reason: 'checksum_mismatch', at: { fileIndex: 1, record: 41002 } }), /two cuts for segment 0/],
    ['an R2 rejection that names a record', (r) => { const [j] = r.rejections.splice(1, 1); j.at = { fileIndex: 1, record: 41500 }; r.rejections.push(j); }, /rule R2 with at a record/],
    ['an R4 rejection whose record no R4 dropped key lists', (r) => (r4At(r).at = { fileIndex: 0, record: 70124 }), /R4 rejections and the records of the R4 dropped keys disagree/],
    ['an R4 rejection naming another field than its key', (r) => (r4At(r).field = 'price'), /R4 rejections and the records of the R4 dropped keys disagree at 0:70123:price/],
    ['an R4 rejection with another segment\'s index', (r) => (r4At(r).segmentIndex = 1), /segmentIndex 1, not that of the segment whose span holds it/],
    ['an R4 rejection with a null segment index inside a segment', (r) => (r4At(r).segmentIndex = null), /segmentIndex null/],
    ['an R4 dropped record with no rejection', (r) => r.dropped.foreignSymbol.records.push({ fileIndex: 0, record: 90000 }) && (r.dropped.foreignSymbol.count = 1), /disagree at 0:90000:pair/],
    ['a supersedes entry that this run reproduces', (r) => (r.supersedes = [{ segmentIndex: 0, fixtureSha256: r.segments[0].fixtureSha256, normalizerVersion: '0.1.0', normalizerCommit: '89abcde', adapterVersion: '1' }]), /supersedes entry for segment 0 that this run reproduces/],
  ])('rejects a schema-valid report with %s (a cross-reference or bound, contract section 6.5)', (_name, change, reason) => {
    expect(classifyNormalizeReport(report(change))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('accepts a foreign-symbol trade item as one R4 rejection naming pair, with the segment whose span holds it', () => {
    const accepted = report((r) => {
      r.dropped.foreignSymbol = { count: 2, records: [{ fileIndex: 0, record: 70200 }] };
      r.rejections.splice(3, 0, { rule: 'R4', scope: 'item', segmentIndex: 0, at: { fileIndex: 0, record: 70200 }, field: 'pair' });
    });
    expect(classifyNormalizeReport(accepted)).toEqual({ ok: true, kind: 'normalize_report_v1' });
    const outside = report((r) => {
      r.dropped.foreignSymbol = { count: 1, records: [{ fileIndex: 1, record: 41210 }] };
      r.dropped.socketNotSubscribed.records.shift();
      r.dropped.socketNotSubscribed.count = 1;
      r.rejections.push({ rule: 'R4', scope: 'item', segmentIndex: null, at: { fileIndex: 1, record: 41210 }, field: 'pair' });
    });
    expect(classifyNormalizeReport(outside)).toEqual({ ok: true, kind: 'normalize_report_v1' });
  });

  it('rejects a run refused at capture level that lists more than one rejection (one R5 per run, or R1b with a later R1)', () => {
    const base = reportExamples.report_r1_unsupported_version!;
    const twoR5 = structuredClone(base);
    twoR5.rejections = [{ rule: 'R5', scope: 'capture', segmentIndex: null, at: null, field: 'qtyDecimals' }, { rule: 'R5', scope: 'capture', segmentIndex: null, at: null, field: 'status' }];
    expect(classifyNormalizeReport(canonicalReport(twoR5))).toMatchObject({ ok: false, reason: expect.stringMatching(/more than its one rejection/) });
    const r1bThenR1 = structuredClone(base);
    r1bThenR1.rejections = [{ rule: 'R1', scope: 'capture', segmentIndex: null, at: { fileIndex: 0, record: 0 }, field: 'captureFormatVersion' }, { rule: 'R1b', scope: 'capture', segmentIndex: null, at: { fileIndex: 0, record: 6 }, field: null }];
    expect(classifyNormalizeReport(canonicalReport(r1bThenR1))).toMatchObject({ ok: false, reason: expect.stringMatching(/more than its one rejection/) });
    const r1bPastFileEnd = structuredClone(base);
    r1bPastFileEnd.rejections = [{ rule: 'R1b', scope: 'capture', segmentIndex: null, at: { fileIndex: 0, record: 6 }, field: null }];
    expect(classifyNormalizeReport(canonicalReport(r1bPastFileEnd))).toEqual({ ok: true, kind: 'normalize_report_v1' });
  });

  it('accepts an R5 refusal naming qtyIncrement, the field of a changed quantity increment', () => {
    const r = structuredClone(reportExamples.report_r1_unsupported_version!);
    r.rejections = [{ rule: 'R5', scope: 'capture', segmentIndex: null, at: null, field: 'qtyIncrement' }];
    expect(classifyNormalizeReport(canonicalReport(r))).toEqual({ ok: true, kind: 'normalize_report_v1' });
  });

  it('requires a tracked report to be named for the capture it carries', () => {
    const text = report();
    expect(classifyTrackedFile(`evidence/${REPORT_NAME}`, text)).toEqual({ ok: true, kind: 'normalize_report_v1' });
    for (const name of ['evidence/a.normalize-report.json', 'trade 81234567 buy 0.0012 @ 62710.5.normalize-report.json', `x/${REPORT_NAME.toUpperCase()}`, '00000000-0000-4000-8000-000000000000.normalize-report.json']) {
      expect(classifyTrackedFile(name, text)).toMatchObject({ ok: false, reason: expect.stringMatching(/file name is not 123e4567-e89b-42d3-a456-426614174000\.normalize-report\.json/) });
    }
  });

  it('accepts the shape of a recorded fixture whose rights block is permitted + sample_permitted (constructed; establishes no permission)', () => {
    expect(classifyJsonl(recordedFixture(publishable))).toEqual({ ok: true, kind: 'recorded_v2_publishable' });
  });

  it('refuses as publishable a recorded fixture whose rights block lacks termsUrl, termsCheckedOn or checkedBy, or a permitted one without its note', () => {
    for (const key of ['termsUrl', 'termsCheckedOn', 'checkedBy', 'note']) {
      const verdict = classifyJsonl(recordedFixture((r) => { publishable(r); delete r[key]; }));
      expect(verdict, key).toMatchObject({ ok: false });
    }
  });

  it('refuses a raw capture record nested at any depth in a recorded fixture, and keeps other undeclared keys open', () => {
    const rawRecord = captureExamples.message_trade as Json;
    const nested = (line: number) => ({ ok: false, reason: `non-blank line ${line} carries a raw capture record nested under one of its keys` });
    expect(classifyJsonl(recordedFixture(publishable, (h) => (h.extra = rawRecord)))).toEqual(nested(1));
    expect(classifyJsonl(recordedFixture(publishable, (h) => (h.provenance.capture.extra = [rawRecord])))).toEqual(nested(1));
    expect(classifyJsonl(recordedFixture(publishable, (h) => (h.provenance.rights.extra = { deeper: rawRecord })))).toEqual(nested(1));
    const withEvent = (k: number, mutate: (e: Json) => void): string => {
      const h = structuredClone(fixtureExamples.header_recorded_qty8!);
      h.eventCount = v2Events.length;
      publishable(h.provenance.rights);
      const events = v2Events.map((e) => structuredClone(e));
      mutate(events[k]!);
      return jsonl([h, ...events]);
    };
    expect(classifyJsonl(withEvent(1, (e) => (e.extra = rawRecord)))).toEqual(nested(3));
    expect(classifyJsonl(withEvent(0, (e) => (e.bids[0].extra = rawRecord)))).toEqual(nested(2));
    // Other undeclared keys stay open (forward compatibility), and an unwrapped venue frame under one is the disclosed class.
    expect(classifyJsonl(recordedFixture(publishable, (h) => (h.extra = { note: 'a forward-compatible field' })))).toEqual({ ok: true, kind: 'recorded_v2_publishable' });
    expect(classifyJsonl(recordedFixture(publishable, (h) => (h.extra = venueFrames.trade)))).toEqual({ ok: true, kind: 'recorded_v2_publishable' });
  });

  const rejects: [string, string, RegExp][] = [
    // Unwrapped venue frames and other unclassified JSONL.
    ['unwrapped book snapshot and update frames', jsonl([venueFrames.bookSnapshot, venueFrames.bookUpdate]), /not a fixture header/],
    ['unwrapped trade frames', jsonl([venueFrames.trade, venueFrames.trade]), /not a fixture header/],
    ['a heartbeat frame', jsonl([venueFrames.heartbeat]), /not a fixture header/],
    ['a subscription acknowledgement followed by a snapshot', jsonl([venueFrames.subscribeAck, venueFrames.bookSnapshot]), /not a fixture header/],
    ['an array-shaped frame', jsonl([[336, { a: [['62710.5', '0.25', '1791288001.130']] }, 'book-100', 'XBT/USD']]), /not a JSON object/],
    ['a synthetic fixture with an unwrapped venue frame appended', withLines([...syntheticLines, JSON.stringify(venueFrames.bookSnapshot)]), /parser rejects it: unknown market event type/],
    // Valid JSON objects or events without an allowed header.
    ['version-1 events without their header', withLines(syntheticLines.slice(1)), /not a fixture header/],
    ['version-2 events without a header', jsonl(v2Events), /not a fixture header/],
    ['an empty object followed by events', jsonl([{}, ...v2Events]), /not a fixture header/],
    ['a header that is not the first line', withLines([syntheticLines[1]!, syntheticLines[0]!, ...syntheticLines.slice(2)]), /not a fixture header/],
    ['a header with no schema version', jsonl([{ type: 'header' }, ...v2Events]), /schemaVersion undefined is not an allowed format/],
    ['a header with an unknown schema version', jsonl([{ ...syntheticHeader(), schemaVersion: 3 }]), /schemaVersion 3 is not an allowed format/],
    // Raw capture records, first or later.
    ['raw capture records', jsonl([captureExamples.manifest_start, captureExamples.message_book_update]), /line 1 is a raw capture record/],
    ['a raw capture record appended to a synthetic fixture', withLines([...syntheticLines, JSON.stringify(captureExamples.message_trade)]), /is a raw capture record/],
    ['a line carrying both receive clocks under an unknown type', withLines([...syntheticLines.slice(0, 2), JSON.stringify({ type: 'frame', recvWallMs: 1, recvMonoNs: '1' })]), /line 3 is a raw capture record/],
    // Recorded fixtures without the required rights shape.
    ['a recorded fixture whose rights are unclear and hash-only (the only admissible block today)', recordedFixture(() => {}), /only with redistribution "permitted" and publication "sample_permitted"/],
    ['a recorded fixture with redistribution permitted but publication hash-only', recordedFixture((r) => (r.redistribution = 'permitted')), /only with redistribution "permitted"/],
    ['a recorded fixture without a rights block', recordedFixture((r) => r, (h) => delete h.provenance.rights), /\$defs\/header: \/provenance must have required property 'rights'/],
    ['a recorded fixture whose permitted note is only a zero-width space', recordedFixture((r) => { publishable(r); r.note = '\u200b'; }), /\/provenance\/rights\/note must match pattern/],
    ['a recorded fixture whose event count does not match', recordedFixture(publishable, (h) => (h.eventCount = 3)), /eventCount 3 does not match the 2 events/],
    ['a recorded fixture with a line that is not a fixture event', withLines([...recordedFixture(publishable).trim().split('\n'), JSON.stringify({ type: 'book', seq: 9 })]), /event 3 does not match fixture.v2 \$defs\/event/],
    ['a version-1 header that is not synthetic', withLines([JSON.stringify({ ...syntheticHeader(), synthetic: false, provenance: { ...syntheticHeader().provenance, source: 'recorded' } }), ...syntheticLines.slice(1)]), /version-1 header must be synthetic/],
    // Synthetic-looking files outside the allowed format.
    ['a version-2 synthetic fixture', jsonl([{ ...fixtureExamples.header_synthetic, eventCount: 2 }, ...v2Events]), /version-2 synthetic fixture is not an allowed format/],
    ['a synthetic fixture whose label was altered', withLines([JSON.stringify({ ...syntheticHeader(), syntheticLabel: 'SYNTHETIC DATA' }), ...syntheticLines.slice(1)]), /parser rejects it: synthetic fixtures must carry the exact SYNTHETIC_LABEL/],
    ['a synthetic header carrying an undeclared key', withLines([JSON.stringify({ ...syntheticHeader(), venueFrames: [venueFrames.bookSnapshot] }), ...syntheticLines.slice(1)]), /outside the version-1 format: venueFrames is not a version-1 key/],
    ['a synthetic header carrying an undeclared provenance key', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, recordedFrom: 'wss://ws.kraken.com/v2' } }), ...syntheticLines.slice(1)]), /outside the version-1 format: provenance\.recordedFrom is not a version-1 key/],
    ['a synthetic header whose description holds raw capture records', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, description: { raw: [captureExamples.manifest_start, captureExamples.message_trade] } } }), ...syntheticLines.slice(1)]), /provenance\.description is missing or has a type outside the version-1 format/],
    ['a synthetic header whose seed holds venue frames', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, seed: [venueFrames.bookSnapshot, venueFrames.trade] } }), ...syntheticLines.slice(1)]), /provenance\.seed is missing or has a type/],
    ['a synthetic header whose time basis holds a venue frame', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, timeBasis: { ...syntheticHeader().provenance.timeBasis, obsTime: venueFrames.bookUpdate } } }), ...syntheticLines.slice(1)]), /provenance\.timeBasis\.obsTime is missing or has a type/],
    ['a synthetic header whose generator holds a raw capture record', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, generator: { raw: captureExamples.message_trade } } }), ...syntheticLines.slice(1)]), /provenance\.generator is missing or has a type/],
    ['a synthetic header whose generator version holds a raw capture record', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, generatorVersion: [captureExamples.manifest_start] } }), ...syntheticLines.slice(1)]), /provenance\.generatorVersion is missing or has a type/],
    ['a synthetic header whose quantity scale is an array', withLines([JSON.stringify({ ...syntheticHeader(), qtyScale: [1000000] }), ...syntheticLines.slice(1)]), /qtyScale is missing or has a type/],
    ['a synthetic header whose market time basis holds a venue frame', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, timeBasis: { ...syntheticHeader().provenance.timeBasis, marketTime: venueFrames.trade } } }), ...syntheticLines.slice(1)]), /provenance\.timeBasis\.marketTime is missing or has a type/],
    ['a synthetic header whose price scale is a string', withLines([JSON.stringify({ ...syntheticHeader(), priceScale: '1000000' }), ...syntheticLines.slice(1)]), /priceScale is missing or has a type/],
    ['a synthetic header without a time basis', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, timeBasis: 'simulated' } }), ...syntheticLines.slice(1)]), /needs provenance\.timeBasis as an object/],
    ['a synthetic trade whose aggressor holds a raw capture record', withTrade((t) => (t.aggressor = { record: captureExamples.message_trade })), /aggressor is not buy, sell or unknown/],
    ['a synthetic trade without an aggressor', withTrade((t) => delete t.aggressor), /aggressor is not buy, sell or unknown/],
    ['a synthetic event carrying an undeclared key', withLines([syntheticLines[0]!, JSON.stringify({ ...JSON.parse(syntheticLines[1]!), frame: JSON.stringify(venueFrames.bookSnapshot) }), ...syntheticLines.slice(2)]), /does not reproduce it byte for byte/],
    ['a synthetic fixture with a blank line inside it', withLines([syntheticLines[0]!, '', ...syntheticLines.slice(1)]), /does not reproduce it byte for byte/],
    ['a synthetic fixture missing one event', withLines(syntheticLines.slice(0, -1)), /parser rejects it: fixture header eventCount/],
    // Files with nothing classifiable.
    ['invalid JSON after a valid header', withLines([syntheticLines[0]!, '{"eventId":']), /line 2 is not valid JSON/],
    ['an empty file', '', /no non-blank line/],
    ['a file of blank lines', '\n  \n\t\n', /no non-blank line/],
  ];

  it.each(rejects)('rejects %s', (_name, text, reason) => {
    const verdict = classifyJsonl(text);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(reason);
  });
});
