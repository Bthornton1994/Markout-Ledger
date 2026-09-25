#!/usr/bin/env node
/**
 * Which single constraints of the three JSON Schemas under schemas/ a test holds.
 *
 * The mutants are generated, deterministically, from the schemas as committed: for every node, each entry of its
 * `required` list is dropped (one mutant each), and each of `pattern`, `format`, `const`, `enum`, `minimum`, `maximum`,
 * `minItems`, `maxItems`, `maxProperties` and an `additionalProperties: false` is deleted (one mutant each). Every mutant
 * only widens what the schema accepts. A mutant is HELD when at least one test that passed before it fails with it; the
 * suites that read the schemas run for every mutant, and the A10 rule's suite (slow) only for the mutants the others
 * leave standing. The CONTROL re-serializes each schema unchanged and must fail nothing.
 *
 * A SURVIVED mutant is either a constraint no test holds or an equivalent mutant (another constraint gives the same
 * verdict on every instance, as when an `if`/`then` also requires the key). Each survivor is listed by schema and JSON
 * pointer, so it can be judged; the count is not a coverage figure.
 *
 * It rewrites the schema files while it runs and restores them at the end, on an interrupt and on an uncaught error. It
 * refuses to start if any schema has uncommitted changes.
 *
 *   npm run proof:schema-mutations -- [--jobs <n>] [--json <file outside the repository>]
 *
 * With --jobs above 1 it needs a clean working tree: each job runs in its own detached worktree of HEAD, removed at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMAS = ['schemas/capture-record.v1.schema.json', 'schemas/fixture.v2.schema.json', 'schemas/normalize-report.v1.schema.json'];
/** The suites that read each schema, besides the A10 rule's (tests/jsonl-policy.ts reads all three). */
const FAST = {
  'schemas/capture-record.v1.schema.json': ['tests/schemas.test.ts', 'tests/capture-structure.test.ts'],
  'schemas/fixture.v2.schema.json': ['tests/schemas.test.ts', 'tests/handoff-gates.test.ts'],
  'schemas/normalize-report.v1.schema.json': ['tests/schemas.test.ts'],
};
const ALL_FAST = [...new Set(Object.values(FAST).flat())];
const SLOW = ['tests/repository-jsonl.test.ts'];
const DELETABLE = ['pattern', 'format', 'const', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems', 'maxProperties'];

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const jsonOut = flag('--json');
const jobs = Number(flag('--jobs') ?? 1);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error('--jobs takes a positive integer');
  process.exit(2);
}
if (jobs > 1 && spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== '') {
  console.error('Refusing to start: --jobs above 1 runs worktrees of HEAD, so the working tree must be clean');
  process.exit(1);
}

const dirty = spawnSync('git', ['status', '--porcelain', '--', ...SCHEMAS], { encoding: 'utf8' }).stdout.trim();
if (dirty) {
  console.error(`Refusing to start: these files have uncommitted changes, and a restore would discard them:\n${dirty}`);
  process.exit(1);
}
const originals = new Map(SCHEMAS.map((f) => [f, readFileSync(f, 'utf8')]));
const worktrees = [];
const restore = () => {
  for (const [f, text] of originals) writeFileSync(f, text);
  for (const dir of worktrees.splice(0)) spawnSync('git', ['worktree', 'remove', '--force', dir], { stdio: 'ignore' });
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Interrupted before the scratch directory existed.
    }
    console.error(`\ninterrupted by ${signal}; schemas restored and job worktrees removed`);
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  restore();
  console.error(`\nuncaught: ${error instanceof Error ? error.message : String(error)}; schemas restored`);
  process.exit(1);
});

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
/** Every mutant of `schema`: { pointer, what, apply(clone) }, in document order. */
function mutantsOf(schema) {
  const out = [];
  const visit = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => visit(v, [...path, i]));
    if (typeof node !== 'object' || node === null) return;
    const at = (root) => path.reduce((n, k) => n[k], root);
    const pointer = '/' + path.map(esc).join('/');
    // A properties or $defs map names members, not keywords: only its values are schemas.
    const map = path.length > 0 && ['properties', '$defs'].includes(path[path.length - 1]) && typeof path[path.length - 1] === 'string';
    if (map) {
      for (const [k, v] of Object.entries(node)) visit(v, [...path, k]);
      return;
    }
    if (Array.isArray(node.required)) {
      for (const name of node.required) out.push({ pointer, what: `required ${name}`, apply: (r) => (at(r).required = at(r).required.filter((x) => x !== name)) });
    }
    for (const k of DELETABLE) if (k in node) out.push({ pointer, what: `no ${k}`, apply: (r) => delete at(r)[k] });
    if (node.additionalProperties === false) out.push({ pointer, what: 'no additionalProperties false', apply: (r) => delete at(r).additionalProperties });
    for (const [k, v] of Object.entries(node)) if (k !== 'enum' && k !== 'const' && k !== 'required') visit(v, [...path, k]);
  };
  visit(schema, []);
  return out;
}

const scratch = mkdtempSync(join(tmpdir(), 'markout-schema-mutation-'));
let reports = 0;
function failingTests(suites, cwd = process.cwd()) {
  return new Promise((done) => {
    const report = join(scratch, `report-${reports++}.json`);
    const child = spawn('npx', ['vitest', 'run', ...suites, '--reporter=json', `--outputFile=${report}`], { stdio: 'ignore', env: process.env, cwd });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(readFileSync(report, 'utf8'));
        const failed = new Set();
        for (const file of parsed.testResults) {
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
  const baseFast = await failingTests(ALL_FAST);
  const baseSlow = await failingTests(SLOW);
  if (baseFast === null || baseSlow === null) throw new Error('no baseline report');
  console.log(`baseline: ${baseFast.size + baseSlow.size} failing`);
  // The control: every schema re-serialized, unchanged in content.
  for (const f of SCHEMAS) writeFileSync(f, JSON.stringify(JSON.parse(originals.get(f)), null, 2) + '\n');
  const control = [...((await failingTests(ALL_FAST)) ?? ['no report']), ...((await failingTests(SLOW)) ?? ['no report'])].filter((n) => !baseFast.has(n) && !baseSlow.has(n));
  restore();
  console.log(`control: ${control.length === 0 ? 'changed nothing' : `FAILED (${control.join(' | ')})`}`);
  if (control.length > 0) results.push({ file: '*', pointer: '', what: 'control', verdict: 'CONTROL FAILED', by: control[0] });
  const queue = SCHEMAS.flatMap((file) => mutantsOf(JSON.parse(originals.get(file))).map((m) => ({ file, ...m }))).map((m, k) => ({ ...m, k }));
  const roots = [process.cwd()];
  for (let j = 1; j < jobs; j++) {
    const dir = join(scratch, `worktree-${j}`);
    spawnSync('git', ['worktree', 'add', '-q', '--detach', dir, 'HEAD'], { stdio: 'ignore' });
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'));
    worktrees.push(dir);
    roots.push(dir);
  }
  let next = 0;
  const worker = async (root) => {
    while (next < queue.length) {
      const m = queue[next++];
      const schema = JSON.parse(originals.get(m.file));
      m.apply(schema);
      const path = join(root, m.file);
      writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
      try {
        let failed = await failingTests(FAST[m.file], root);
        let newly = failed === null ? null : [...failed].filter((n) => !baseFast.has(n));
        if (newly !== null && newly.length === 0) {
          failed = await failingTests(SLOW, root);
          newly = failed === null ? null : [...failed].filter((n) => !baseSlow.has(n));
        }
        const verdict = newly === null ? 'NO REPORT' : newly.length > 0 ? 'HELD' : 'SURVIVED';
        results.push({ k: m.k, file: m.file, pointer: m.pointer, what: m.what, verdict, by: newly?.[0] ?? null });
        if (verdict !== 'HELD') console.log(`${verdict.padEnd(9)} ${m.file} ${m.pointer}: ${m.what}`);
      } finally {
        writeFileSync(path, originals.get(m.file));
      }
    }
  };
  await Promise.all(roots.map(worker));
} finally {
  restore();
  rmSync(scratch, { recursive: true, force: true });
}
// Workers finish in any order; the report is in the generator's order.
results.sort((a, b) => (a.k ?? -1) - (b.k ?? -1));

const held = results.filter((r) => r.verdict === 'HELD').length;
const total = results.filter((r) => r.what !== 'control').length;
if (total !== SCHEMAS.reduce((n, f) => n + mutantsOf(JSON.parse(originals.get(f))).length, 0)) console.log('NOT EVERY MUTANT RAN');
console.log(`\n${held} of ${total} single-constraint mutants held; ${total - held} not (survivors listed above).`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2) + '\n');
process.exit(results.some((r) => r.verdict === 'CONTROL FAILED' || r.verdict === 'NO REPORT') ? 1 : 0);
