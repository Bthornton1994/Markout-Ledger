// A10 (docs/M2_GROK_HANDOFF.md; docs/M2_DATA_CONTRACT.md section 6.5): every tracked .jsonl file must be an allowed
// fixture, every tracked normalize report must match its closed schema, nothing under captures/ or normalized/ may be
// tracked, and the rule fails closed on anything it cannot classify, in the tree under test and in every commit of a
// range. The constructed cases below are illustrative:
// the venue frames use the public WebSocket API v2 field names with invented values, and a passing recorded-fixture
// case shows only that the rights block has the required shape. It establishes no permission; the owner verifies the
// attested clearance by hand before any recorded fixture is committed (decision condition C2).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalReport,
  classifyJsonl,
  classifyNormalizeReport,
  classifyRepoPath,
  classifyTrackedFile,
  historyViolations,
  readRepoFile,
  repoRootPath,
  trackedHygieneFiles,
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

  it('lists every file force-added under captures/ and normalized/, whatever its name, and rejects each', () => {
    const inCaptureDirs = ['captures/123e4567-e89b-42d3-a456-426614174000-0.jsonl', 'captures/notes.txt', 'normalized/seg0.jsonl', 'normalized/run.normalize-report.json', 'normalized/deep/x.bin', 'Captures/x.jsonl.gz', 'NORMALIZED/notes.txt'];
    const root = newRepo({ '.gitignore': 'captures/\nnormalized/\nCaptures/\nNORMALIZED/\n', 'fixtures/synthetic-baseline.jsonl': synthetic, ...Object.fromEntries(inCaptureDirs.map((p) => [p, raw])) });
    gitIn(root, 'add', '-A', '-f');
    expect(trackedHygieneFiles(root)).toEqual([...inCaptureDirs, 'fixtures/synthetic-baseline.jsonl'].sort());
    for (const path of inCaptureDirs) expect(classifyRepoPath(path, root)).toMatchObject({ ok: false, reason: expect.stringMatching(/under captures\/ or normalized\//) });
  });

  it('lists normalize reports anywhere, in any letter case, and checks them against the closed report schema', () => {
    const root = newRepo({ 'evidence/a.normalize-report.json': report(), 'evidence/B.NORMALIZE-REPORT.JSON': report((r) => (r.payload = '{"channel":"book"}')) });
    gitIn(root, 'add', '-A', '-f');
    expect(trackedHygieneFiles(root)).toEqual(['evidence/B.NORMALIZE-REPORT.JSON', 'evidence/a.normalize-report.json']);
    expect(classifyTrackedFile('evidence/a.normalize-report.json', readRepoFile('evidence/a.normalize-report.json', root))).toEqual({ ok: true, kind: 'normalize_report_v1' });
    expect(classifyTrackedFile('evidence/B.NORMALIZE-REPORT.JSON', readRepoFile('evidence/B.NORMALIZE-REPORT.JSON', root))).toMatchObject({ ok: false, reason: expect.stringMatching(/must NOT have additional properties/) });
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
      'deep/r.normalize-report.json': report(),
      'node_modules/pkg/x.jsonl': raw,
      'out/baseline/steered.ledger.jsonl': raw,
      'dist/x.jsonl': raw,
    });
    expect(trackedHygieneFiles(root)).toEqual(['CAPTURES/other.txt', 'captures/cap-0.jsonl', 'captures/readme.txt', 'deep/out/raw.jsonl', 'deep/r.normalize-report.json', 'fixtures/a.jsonl', 'normalized/seg.jsonl']);
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

  it('names the commit that brought a disallowed file into the range, however many later commits keep it', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'data.jsonl'), raw);
    const added = commitAll(root, 'add a raw capture');
    writeFileSync(join(root, 'README.md'), 'y');
    commitAll(root, 'an unrelated change that keeps it');
    expect(historyViolations(root, [`${base}..HEAD`])).toEqual({ commits: 2, blobsChecked: 1, violations: [{ commit: added, path: 'data.jsonl', reason: expect.stringMatching(/raw capture record/) }] });
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
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([{ commit: added, path: 'captures/c-0.jsonl.gz', reason: expect.stringMatching(/under captures\/ or normalized\//) }]);
  });

  it('finds a normalize report that carried a value outside the closed schema in an earlier commit of the range', () => {
    const root = newRepo({ 'README.md': 'x' });
    const base = commitAll(root, 'base');
    writeFileSync(join(root, 'evidence.normalize-report.json'), report((r) => (r.dropped.depthWhileUnsynced.values = ['62710.4'])));
    const leaked = commitAll(root, 'report with values');
    writeFileSync(join(root, 'evidence.normalize-report.json'), report());
    commitAll(root, 'report fixed');
    const scan = historyViolations(root, [`${base}..HEAD`]);
    expect(scan.violations).toEqual([{ commit: leaked, path: 'evidence.normalize-report.json', reason: expect.stringMatching(/additional properties/) }]);
  });

  it('scans exactly the commits the range names: an earlier deleted file is outside base..head, inside a full scan of head', () => {
    const root = newRepo({ 'old.jsonl': raw });
    const early = commitAll(root, 'a violation before the base');
    gitIn(root, 'rm', '-q', 'old.jsonl');
    const base = commitAll(root, 'deleted before the base');
    writeFileSync(join(root, 'fixture.jsonl'), synthetic);
    commitAll(root, 'a clean commit');
    expect(historyViolations(root, [`${base}..HEAD`])).toEqual({ commits: 1, blobsChecked: 1, violations: [] });
    expect(historyViolations(root, ['HEAD'])).toEqual({ commits: 3, blobsChecked: 2, violations: [{ commit: early, path: 'old.jsonl', reason: expect.stringMatching(/raw capture record/) }] });
  });

  it('scans each commit of the range whole, so a disallowed file the base already carries is reported with the first commit', () => {
    const root = newRepo({ 'old.jsonl': raw });
    const base = commitAll(root, 'a violation in the base');
    writeFileSync(join(root, 'fixture.jsonl'), synthetic);
    const first = commitAll(root, 'a clean commit on top');
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([{ commit: first, path: 'old.jsonl', reason: expect.stringMatching(/raw capture record/) }]);
  });

  it('checks each distinct (content, path) pair: a later bad version of a path, and identical bytes under a new path', () => {
    const root = newRepo({ 'evidence.normalize-report.json': report() });
    const base = commitAll(root, 'a clean report in the base');
    writeFileSync(join(root, 'evidence.normalize-report.json'), report((r) => (r.dropped.depthWhileUnsynced.values = ['62710.4'])));
    const leaked = commitAll(root, 'a later version with values');
    writeFileSync(join(root, 'evidence.normalize-report.json'), report());
    commitAll(root, 'back to clean');
    writeFileSync(join(root, 'f.jsonl'), synthetic);
    commitAll(root, 'an allowed fixture');
    mkdirSync(join(root, 'captures'));
    writeFileSync(join(root, 'captures', 'f.jsonl'), synthetic);
    gitIn(root, 'add', '-f', 'captures/f.jsonl');
    const forced = commitAll(root, 'the same bytes under captures/');
    expect(historyViolations(root, [`${base}..HEAD`]).violations).toEqual([
      { commit: leaked, path: 'evidence.normalize-report.json', reason: expect.stringMatching(/additional properties/) },
      { commit: forced, path: 'captures/f.jsonl', reason: expect.stringMatching(/under captures\/ or normalized\//) },
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
      { commit: added, path: 'Normalized/seg.txt', reason: expect.stringMatching(/under captures\/ or normalized\//) },
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
  /** A clone opted in exactly as the contract says, with a bare remote; its node_modules and tests are the repository's own, untracked. */
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
  ])('rejects a schema-valid report with %s, so an order or a name carries nothing', (_name, change, reason) => {
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
  ])('rejects a schema-valid report with %s, so a free choice among codes carries nothing', (_name, change, reason) => {
    expect(classifyNormalizeReport(report(change))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('accepts the shape of a recorded fixture whose rights block is permitted + sample_permitted (constructed; establishes no permission)', () => {
    expect(classifyJsonl(recordedFixture(publishable))).toEqual({ ok: true, kind: 'recorded_v2_publishable' });
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
