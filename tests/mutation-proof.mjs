#!/usr/bin/env node
/**
 * Proof that each guard named below is held by a test that fails without it.
 *
 * Each entry undoes ONE guard by an exact textual replacement in one file and runs the suite meant to hold it. A guard
 * is HELD when at least one test that passed before the change fails after it; scoring is the difference between the
 * failing-test sets read from vitest's JSON report, never an exit code or a count. The CONTROL entry changes only a
 * comment and must fail nothing. A replacement whose text does not occur exactly once is NOT APPLIED, which fails the
 * run, so an entry cannot go stale silently.
 *
 * What this proves: removing each listed guard is noticed. What it does not prove: that the list is complete, that a
 * guard is sufficient, or anything about guards not listed here.
 *
 * It edits the files it names while it runs and restores them at the end, on an interrupt and on an uncaught error. It
 * refuses to start if any of those files has uncommitted changes, so a restore can never discard work.
 *
 *   npm run proof:mutations            every entry
 *   npm run proof:mutations -- M5-     only entries whose id starts with M5-
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REF = 'tests/capture-structure.ts';
const REF_SUITE = 'tests/capture-structure.test.ts';
const RULE = 'tests/jsonl-policy.ts';
const RULE_SUITE = 'tests/repository-jsonl.test.ts';

const MUTANTS = [
  // M5: rules of the reference checker that PR-1's normalizer must reproduce (handoff A7(r)).
  { id: 'M5-THREE-SAMPLES', guard: 'a segment needs three WebSocket method-response samples before they are its clock source', file: REF, suite: REF_SUITE,
    from: "const source = ws.length >= 3 ? 'ws_method_response'", to: "const source = ws.length >= 2 ? 'ws_method_response'" },
  { id: 'M5-END-SUBSCRIBE-REJECTED', guard: 'subscribe_rejected ends the capture', file: REF, suite: REF_SUITE,
    from: "'operator_stop', 'subscribe_rejected', 'resync_budget_exhausted'", to: "'operator_stop', 'resync_budget_exhausted'" },
  { id: 'M5-END-OPERATOR-STOP', guard: 'operator_stop ends the capture', file: REF, suite: REF_SUITE,
    from: "const ENDS = new Set(['capture_end', 'operator_stop', ", to: "const ENDS = new Set(['capture_end', " },
  { id: 'M5-END-RESYNC-BUDGET', guard: 'resync_budget_exhausted ends the capture', file: REF, suite: REF_SUITE,
    from: "'subscribe_rejected', 'resync_budget_exhausted', 'reconnect_budget_exhausted']", to: "'subscribe_rejected', 'reconnect_budget_exhausted']" },
  { id: 'M5-END-RECONNECT-BUDGET', guard: 'reconnect_budget_exhausted ends the capture', file: REF, suite: REF_SUITE,
    from: "'resync_budget_exhausted', 'reconnect_budget_exhausted']);", to: "'resync_budget_exhausted']);" },
  { id: 'M5-RESYNC-FAILED', guard: 'ws_close resync_failed is a single-record settlement of an open socket', file: REF, suite: REF_SUITE,
    from: "  'resync_failed', 'snapshot_timeout',", to: "  'snapshot_timeout'," },
  { id: 'M5-SETTLEMENT-ADJACENT', guard: "a two-record settlement's ws_close follows its first record directly", file: REF, suite: REF_SUITE,
    from: "    if (pending) {\n      if (!(r.type === 'ws_close'", to: "    if (pending) {\n      if (FREE.has(r.type)) continue;\n      if (!(r.type === 'ws_close'" },
  { id: 'M5-REJECTED-ACK', guard: 'a response with success other than true is no acknowledgement', file: REF, suite: REF_SUITE,
    from: "else if (p.success === true && method === 'subscribe'", to: "else if (method === 'subscribe'" },
  { id: 'M5-FAILED-SUBSCRIPTION', guard: 'a matched subscription response with success false demands its settlement on the next record', file: REF, suite: REF_SUITE,
    from: "else if (p.success === false && (method === 'subscribe' || method === 'unsubscribe')) demand =", to: "else if (false && (method === 'subscribe' || method === 'unsubscribe')) demand =" },
  { id: 'M5-QTY-SCALE-SIZES', guard: 'a recorded fixture event size must have decimalsOf(header.qtyScale) places', file: RULE, suite: RULE_SUITE,
    from: 'if (!v2FixtureLines([header, ...events])) return fail(', to: 'if (false) return fail(' },
  { id: 'M5-UNIQUE-REQ-ID', guard: "every request's req_id exceeds every earlier req_id of the capture", file: REF, suite: REF_SUITE,
    from: 'if (request.reqId <= lastReqId)', to: 'if (request.reqId < lastReqId)' },
  { id: 'M5-PROBE-AFTER-END', guard: "a probe after a segment's last record is not its sample", file: REF, suite: REF_SUITE,
    from: "r.type === 'probe' && i >= epoch && i <= end &&", to: "r.type === 'probe' && i >= epoch &&" },

  // H1: every pointer form git-lfs decodes is refused (contract section 6.5).
  { id: 'H1-ALIAS-GIT-MEDIA', guard: 'the git-media.io/v/2 version alias is a pointer', file: RULE, suite: RULE_SUITE,
    from: "'https://hawser.github.com/spec/v1', 'http://git-media.io/v/2']", to: "'https://hawser.github.com/spec/v1']" },
  { id: 'H1-ALIAS-HAWSER', guard: 'the hawser.github.com/spec/v1 version alias is a pointer', file: RULE, suite: RULE_SUITE,
    from: "'https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1', ", to: "'https://git-lfs.github.com/spec/v1', " },
  { id: 'H1-LEADING-SPACE', guard: 'whitespace before the version line is skipped, as git-lfs trims it', file: RULE, suite: RULE_SUITE,
    from: ".decode(bytes.subarray(0, LFS_POINTER_BYTES)).replace(LFS_EDGE, '');", to: ".decode(bytes.subarray(0, LFS_POINTER_BYTES));" },
  { id: 'H1-BLANK-LINES', guard: 'blank lines before the version line are skipped', file: RULE, suite: RULE_SUITE,
    from: '    if (line.length === 0) continue;\n    const [key', to: '    const [key' },
  { id: 'H1-EXT-LINES', guard: 'ext- lines before the version line are skipped', file: RULE, suite: RULE_SUITE,
    from: '    if (LFS_EXT_KEY.test(key)) continue;\n', to: '' },
  { id: 'H1-LINE-TRIM', guard: 'spaces around the version line are trimmed', file: RULE, suite: RULE_SUITE,
    from: "const line = raw.replace(/\\r$/, '').trim();", to: "const line = raw.replace(/\\r$/, '');" },
  { id: 'H1-BYTES-FIRST', guard: 'the pointer check runs on the bytes, before the strict UTF-8 decode', file: RULE, suite: RULE_SUITE,
    from: "  if (isLfsPointer(bytes)) return fail(", to: "  if (false) return fail(" },

  // M1: every tracked entry outside the kinds is read by object id or refused.
  { id: 'M1-UNREADABLE-BLOB', guard: 'a blob git cannot read is refused', file: RULE, suite: RULE_SUITE,
    from: '    return fail(UNREADABLE_ENTRY_REASON);', to: "    return { ok: true, kind: 'not_inspected' };" },
  { id: 'M1-INDEX-BLOB', guard: "an entry is read from the index by object id, not only from the working tree", file: RULE, suite: RULE_SUITE,
    from: '  const verdict = classifyOtherFile(blob);\n  if (!verdict.ok || !entry.utf8) return verdict;', to: "  const verdict: Verdict = { ok: true, kind: 'not_inspected' };\n  if (!entry.utf8) return verdict;" },
  { id: 'M1-WORKTREE-TOO', guard: "the working-tree bytes are checked too, so an unstaged change is not missed", file: RULE, suite: RULE_SUITE,
    from: '  if (stat?.isFile()) return worse(verdict, classifyOtherFile(readFileSync(join(root, entry.path))));', to: '' },
  { id: 'M1-MISSING-PATH', guard: 'a path neither in the index nor in the working tree is refused', file: RULE, suite: RULE_SUITE,
    from: '  if (stat === undefined) return fail(MISSING_OTHER_REASON);', to: "  if (stat === undefined) return { ok: true, kind: 'not_inspected' };" },
  { id: 'M1-UNKNOWN-MODE', guard: 'an index mode the rule does not read is refused', file: RULE, suite: RULE_SUITE,
    from: "  if (!/^(100644|100755|120000)$/.test(entry.mode)) return fail(", to: "  if (false) return fail(" },
  { id: 'M1-NOT-UTF8-COVERED', guard: 'a covered path whose name is not UTF-8 is refused in history', file: RULE, suite: RULE_SUITE,
    from: '        violations.push({ commit, path, reason: NOT_UTF8_NAME_REASON });\n        continue;', to: '' },
  { id: 'M1-ESCAPE-BACKSLASH', guard: 'a backslash in a name that is not UTF-8 is escaped, so two names never collide', file: RULE, suite: RULE_SUITE,
    from: 'b >= 0x80 || b === 0x5c ?', to: 'b >= 0x80 ?' },

  // M4: the manifest's REST AssetPairs specification (R5, contract sections 5.10 and 8.4).
  { id: 'M4-REST-CALLED', guard: "the manifest's REST specification is checked at all", file: REF, suite: REF_SUITE,
    from: "  if (typeof rest === 'string') return refuse('R5', 0, rest);", to: "  if (typeof rest === 'string' && false) return refuse('R5', 0, rest);" },
  { id: 'M4-REST-ERROR', guard: 'a REST payload reporting an error gives no specification', file: REF, suite: REF_SUITE,
    from: '|| payload.error.length > 0 ||', to: '||' },
  { id: 'M4-REST-EMPTY', guard: 'a REST payload with no entry for the REST name gives no specification', file: REF, suite: REF_SUITE,
    from: "  if (entries.length === 0) return `the manifest's REST", to: "  if (entries.length === -1) return `the manifest's REST" },
  { id: 'M4-REST-DUPLICATE', guard: 'a REST payload listing the REST name twice gives no specification', file: REF, suite: REF_SUITE,
    from: '  if (entries.length > 1) return `the manifest', to: '  if (entries.length > 2) return `the manifest' },
  { id: 'M4-REST-SHAPE', guard: 'REST decimals must be integers and tick_size a plain decimal string', file: REF, suite: REF_SUITE,
    from: "  if (!Number.isInteger(e.pair_decimals) || !Number.isInteger(e.lot_decimals) || typeof e.tick_size !== 'string' || !/^\\d+(\\.\\d+)?$/.test(e.tick_size)) {", to: '  if (false) {' },
  { id: 'M4-REST-STATUS', guard: 'a REST status, when present, must be online', file: REF, suite: REF_SUITE,
    from: "  if (e.status !== undefined && e.status !== 'online') return", to: "  if (false) return" },
  { id: 'M4-CROSS-PAIR-DECIMALS', guard: 'REST pair_decimals must equal the channel price_precision', file: REF, suite: REF_SUITE,
    from: 'if (pair.price_precision !== rest.pair_decimals || ', to: 'if (' },
  { id: 'M4-CROSS-LOT-DECIMALS', guard: 'REST lot_decimals must equal the channel qty_precision', file: REF, suite: REF_SUITE,
    from: 'pair.qty_precision !== rest.lot_decimals || ', to: '' },
  { id: 'M4-CROSS-TICK', guard: 'REST tick_size must equal the channel price_increment by value', file: REF, suite: REF_SUITE,
    from: ' || !sameDecimal(pair.price_increment, rest.tick_size)) {', to: ') {' },

  // Lows that bear on leak prevention and hook integrity (review of 66c19e2: A10C-3, A10H-1, A10H-4, A10H-5, A10H-7).
  { id: 'LOW-INVISIBLE-EDGE', guard: "the characters the non-blank rule counts as invisible are edge padding", file: RULE, suite: RULE_SUITE,
    from: String.raw`\p{M}\p{Default_Ignorable_Code_Point}\u2800\u303F\uFFFC\u{13441}\u{13442}\u{1D159}`, to: String.raw`\p{M}` },
  { id: 'LOW-HOOK-NO-REPLACE', guard: 'the hook ignores replace refs, so it reads the tag a push sends', file: '.githooks/pre-push', suite: RULE_SUITE,
    from: '\nexport GIT_NO_REPLACE_OBJECTS=1\n', to: '\n' },
  { id: 'LOW-HISTORY-SIDE-BRANCH', guard: "the history scan reads a merge's side branch", file: RULE, suite: RULE_SUITE,
    from: "git(root, ['rev-list', '--reverse', ...revArgs])", to: "git(root, ['rev-list', '--reverse', '--first-parent', ...revArgs])" },
  { id: 'LOW-TAG-EXIT-FOUND', guard: 'the tag scan exits 1 when a tag message holds a raw record', file: 'tests/a10-history-cli.ts', suite: RULE_SUITE,
    from: 'return violations.length === 0 ? 0 : 1;', to: 'return 0;' },
  { id: 'LOW-TAG-EXIT-FAILED', guard: 'the tag scan exits 2 when it cannot scan the tag', file: 'tests/a10-history-cli.ts', suite: RULE_SUITE,
    from: "    console.error(`A10 tag: the tag could not be scanned: ${(e as Error).message}`);\n    return 2;", to: "    console.error(`A10 tag: the tag could not be scanned: ${(e as Error).message}`);\n    return 0;" },
  { id: 'LOW-CI-FULL-CLONE', guard: 'CI checks out every commit, so the history step can scan the range', file: '.github/workflows/ci.yml', suite: RULE_SUITE,
    from: 'fetch-depth: 0 #', to: 'fetch-depth: 1 #' },
  { id: 'LOW-CI-HISTORY-STEP', guard: 'CI runs the history scan over the pull request or push range', file: '.github/workflows/ci.yml', suite: RULE_SUITE,
    from: 'run: npm run test:history -- --base "$A10_BASE" --head "$A10_HEAD"', to: 'run: npm run test:history -- --base "$A10_HEAD" --head "$A10_HEAD"' },
  { id: 'LOW-INSTALL-CHMOD', guard: 'the documented install leaves the hook executable', file: 'README.md', suite: RULE_SUITE,
    from: '"$(git rev-parse --git-path hooks)/pre-push" && chmod +x "$(git rev-parse --git-path hooks)/pre-push"   #', to: '"$(git rev-parse --git-path hooks)/pre-push"   #' },

  { id: 'LOW-MID-MANIFEST-END', guard: "a manifest_end followed by more records is R1b at that manifest_end", file: REF, suite: REF_SUITE,
    from: "return refuse('R1b', i, \"a manifest_end after a file_end", to: "return refuse('R10', i, \"a manifest_end after a file_end" },

  { id: 'LOW-RECORD-BY-TYPE', guard: 'an object whose type is a raw record type is a raw record, without its clocks', file: RULE, suite: RULE_SUITE,
    from: "return (typeof v.type === 'string' && CAPTURE_RECORD_TYPES.has(v.type)) || ('recvWallMs' in v && 'recvMonoNs' in v);", to: "return 'recvWallMs' in v && 'recvMonoNs' in v;" },
  { id: 'LOW-RECORD-BY-CLOCKS', guard: 'an object with both receive clocks is a raw record, whatever its type', file: RULE, suite: RULE_SUITE,
    from: "return (typeof v.type === 'string' && CAPTURE_RECORD_TYPES.has(v.type)) || ('recvWallMs' in v && 'recvMonoNs' in v);", to: "return typeof v.type === 'string' && CAPTURE_RECORD_TYPES.has(v.type);" },
  { id: 'LOW-MODE-EXECUTABLE', guard: 'an executable file (mode 100755) is read like any other', file: RULE, suite: RULE_SUITE,
    from: '/^(100644|100755|120000)$/', to: '/^(100644|120000)$/' },

  { id: 'CONTROL', guard: 'a comment-only change fails nothing', file: REF, suite: REF_SUITE, control: true,
    from: '/** Records that belong to no socket and may appear anywhere before the capture ends. */', to: '/** Records that belong to no socket and may appear anywhere before the capture ends (control). */' },
];

const only = process.argv[2];
const selected = MUTANTS.filter((m) => m.control || !only || m.id.startsWith(only));
const FILES = [...new Set(selected.map((m) => m.file))];

const dirty = spawnSync('git', ['status', '--porcelain', '--', ...FILES], { encoding: 'utf8' }).stdout.trim();
if (dirty) {
  console.error(`Refusing to start: these files have uncommitted changes, and a restore would discard them:\n${dirty}`);
  process.exit(1);
}

const originals = new Map(FILES.map((file) => [file, readFileSync(file, 'utf8')]));
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    console.error(`\ninterrupted by ${signal}; ${FILES.join(', ')} restored`);
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  restore();
  console.error(`\nuncaught: ${error instanceof Error ? error.message : String(error)}; files restored`);
  process.exit(1);
});

const scratch = mkdtempSync(join(tmpdir(), 'markout-mutation-'));
let reports = 0;

/** The full names of the tests that failed in `suite`, or null when vitest wrote no report. */
function failingTests(suite) {
  return new Promise((done) => {
    const report = join(scratch, `report-${reports++}.json`);
    const child = spawn('npx', ['vitest', 'run', suite, '--reporter=json', `--outputFile=${report}`], { stdio: 'ignore', env: process.env });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(readFileSync(report, 'utf8'));
        const failed = new Set();
        for (const file of parsed.testResults) {
          // A file that threw at import ran no assertions; count it as failed.
          if (file.status === 'failed' && file.assertionResults.length === 0) failed.add(`${file.name}: failed to load`);
          for (const test of file.assertionResults) if (test.status === 'failed') failed.add(test.fullName);
        }
        done(failed);
      } catch {
        done(null);
      }
    });
  });
}

const results = [];
try {
  const baseline = new Map();
  for (const suite of new Set(selected.map((m) => m.suite))) {
    const failed = await failingTests(suite);
    if (failed === null) throw new Error(`no report from ${suite}`);
    baseline.set(suite, failed);
    console.log(`baseline ${suite}: ${failed.size} failing`);
  }
  for (const mutant of selected) {
    const text = originals.get(mutant.file);
    const count = text.split(mutant.from).length - 1;
    if (count !== 1) {
      results.push({ ...mutant, verdict: 'NOT APPLIED', detail: `the text to replace occurs ${count} times` });
    } else {
      writeFileSync(mutant.file, text.replace(mutant.from, mutant.to));
      try {
        const failed = await failingTests(mutant.suite);
        if (failed === null) results.push({ ...mutant, verdict: 'NO REPORT', detail: 'vitest wrote no report' });
        else {
          const newly = [...failed].filter((name) => !baseline.get(mutant.suite).has(name));
          const verdict = mutant.control ? (newly.length === 0 ? 'CONTROL OK' : 'CONTROL FAILED') : newly.length > 0 ? 'HELD' : 'SURVIVED';
          results.push({ ...mutant, verdict, detail: newly.length ? `${newly.length} test(s), e.g. ${newly[0]}` : 'no test failed' });
        }
      } finally {
        writeFileSync(mutant.file, text);
      }
    }
    const last = results[results.length - 1];
    console.log(`${last.verdict.padEnd(14)} ${mutant.id}: ${last.detail}`);
  }
} finally {
  restore();
  rmSync(scratch, { recursive: true, force: true });
}

const held = results.filter((r) => r.verdict === 'HELD').length;
const mutants = results.filter((r) => !r.control).length;
const controlOk = results.some((r) => r.verdict === 'CONTROL OK');
console.log(`\n${held} of ${mutants} guards held; control ${controlOk ? 'changed nothing' : 'FAILED'}.`);
process.exit(held === mutants && controlOk ? 0 : 1);
