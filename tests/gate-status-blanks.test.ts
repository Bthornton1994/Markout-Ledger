// Locks the v1 gate status and the P0 readiness document: C2, C3 and C5 are OUT_OF_SCOPE for v1 (not PASSED, not MET)
// with blank owner fields, the evidence lists stay reopened-gate requirements, and P0 stays not authorized. It proves the
// offline gate-status check passes on this checkout and fails when a status row says MET, PASS, PASSED or UNMET, when an
// owner field is filled, when a required v1 sentence is dropped, or when wording states a gate as met, passed or cleared.
// It does not loosen or replace tests/offline-ops.test.ts, which keeps its own locks on the packet, the rollback document
// and release prep.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(repo, path), 'utf8').replace(/\r\n/g, '\n');
const script = join(repo, 'scripts', 'gate-status-check.mjs');
const run = (root?: string) => spawnSync(process.execPath, root ? [script, '--root', root] : [script], { encoding: 'utf8' });

const DOCS = ['docs/OWNER_GATE_STATUS.md', 'docs/OWNER_P0_READINESS.md', 'docs/POST_MERGE_OWNER_PACKET.md', 'docs/DEPLOYMENT_ROLLBACK.md'];

describe('the v1 gate status stays OUT_OF_SCOPE and blank', () => {
  const status = read('docs/OWNER_GATE_STATUS.md');

  it('marks C2, C3 and C5 OUT_OF_SCOPE with blank owner fields and claims none of them passed or met', () => {
    const rows = status.split('\n').filter((line) => /^\| C[235] \| [A-Za-z_]+ \|/.test(line));
    expect(rows).toEqual(['| C2 | OUT_OF_SCOPE | ________ |', '| C3 | OUT_OF_SCOPE | ________ |', '| C5 | OUT_OF_SCOPE | ________ |']);
    expect(status).toContain('C2, C3, and C5 are OUT OF SCOPE FOR V1 (not PASSED).');
    expect(status).toContain('OUT OF SCOPE FOR V1, not PASSED, not MET');
    expect(status).not.toMatch(/\bC[235] is met\b/i);
    expect(status).not.toMatch(/\|\s*(?:MET|PASS|PASSED|UNMET)\s*\|/i);
  });

  it('states the v1 path and the reopening rule, and points at the research note and the audit folder', () => {
    expect(status).toContain('offline evaluation on synthetic fixtures and data with documented rights for the intended use only');
    expect(status).toContain('There is no Kraken adapter on the default path');
    expect(status).toContain('Pursuing a Kraken adapter later reopens C2, C3, and C5.');
    for (const target of ['C5_RESEARCH_NOTE_2026-10-02.md', 'audit/t1780u-offline-v1/']) {
      expect(status).toContain(`](${target})`);
      expect(existsSync(join(repo, 'docs', target)), target).toBe(true);
    }
  });

  it('keeps the evidence each gate would need as reopened-gate requirements, not v1 work', () => {
    expect(status).toMatch(/reopened-gate requirements, not v1 work/);
    for (const use of ['(i)', '(ii)', '(iii)', '(iv)']) expect(status).toContain(`- ${use} `);
    expect(status).toMatch(/P0 payload retention answer/);
    expect(status).toMatch(/Currency: before the P0 listing, and again before each capture day/);
    expect(status).toMatch(/Host located in a served US state: yes or no\./);
    expect(status).toMatch(/Operator resides in a served US state: yes or no\./);
    expect(status).toMatch(/no VPN, proxy, remote host, or third party in another jurisdiction/);
    for (const item of ['`tradeIdOrdered: true`', '`tradeStreamGranularity: per_fill`', 'The 15 s liveness timeout']) expect(status).toContain(item);
    expect(status).toMatch(/confirms the contract's assumption, contradicts it, or does not address it/);
    expect(status).toMatch(/No capture starts while C2, C3, or C5 is UNMET\. The P0 listing does not wait for C5\./);
  });

  it('cites the live main SHA as context only and leaves the release prep recorded tip alone', () => {
    expect(status).toContain('`c408f79f9ed154191b065d1dafcd9d87c5bed62c`. That SHA is not a clearance and not a release tip.');
    expect(status).toContain('still records the pull request #6 merge as its tip');
  });
});

describe('owner P0 readiness is owner only, out of scope for v1, and not authorized', () => {
  const p0 = read('docs/OWNER_P0_READINESS.md');

  it('opens with the not-authorized banner and keeps every precondition and record blank', () => {
    expect(p0.split('\n')[2]).toMatch(/^\*\*NOT AUTHORIZED TO RUN\.\*\* The P0 listing is NOT AUTHORIZED and is out of scope for v1/);
    const fills = p0.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| ---') && !/\| Owner fills \|$/.test(line));
    expect(fills.length).toBeGreaterThanOrEqual(9);
    for (const row of fills) expect(row).toMatch(/\| ________ \|$/);
  });

  it('says P0 is out of scope because v1 does not list or capture, and that C2 and C3 are OUT OF SCOPE, not passed', () => {
    expect(p0).toContain('v1 is offline evaluation and does not list pairs or capture');
    expect(p0).toContain('For v1, C2 and C3 are OUT OF SCOPE (not PASSED)');
  });

  it('keeps P0 away from agents and the venue payload out of the repository, and keeps capture behind C5', () => {
    expect(p0).toMatch(/every agent, subagent or automated session never run P0/);
    expect(p0).toMatch(/Never commit it, never paste it into a pull request/);
    expect(p0).toMatch(/C5 is not required for P0\. C5 is required before any capture/);
  });
});

describe('scripts/gate-status-check.mjs', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('passes on this checkout, reports C2, C3 and C5 OUT_OF_SCOPE, and never reports a gate as met or passed', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/C2, C3 and C5 are OUT_OF_SCOPE for v1/);
    for (const gate of ['  C2 ', '  C3 ', '  C5 ']) expect(r.stdout).toContain(gate);
    expect(r.stdout).not.toMatch(/\bmet\b/i);
    expect(r.stdout).not.toMatch(/\bpass(?:ed|es)?\b/i);
  });

  const copy = (): string => {
    tmp = mkdtempSync(join(tmpdir(), 'gate-status-'));
    mkdirSync(join(tmp, 'docs'));
    for (const path of DOCS) cpSync(join(repo, path), join(tmp, path));
    return tmp;
  };

  it.each([
    ['docs/OWNER_GATE_STATUS.md', '| C3 | OUT_OF_SCOPE | ________ |', '| C3 | MET | ________ |'],
    ['docs/OWNER_GATE_STATUS.md', '| C2 | OUT_OF_SCOPE | ________ |', '| C2 | PASSED | ________ |'],
    ['docs/OWNER_GATE_STATUS.md', '| C5 | OUT_OF_SCOPE | ________ |', '| C5 | PASS | ________ |'],
    ['docs/OWNER_GATE_STATUS.md', '| C2 | OUT_OF_SCOPE | ________ |', '| C2 | UNMET | ________ |'],
    ['docs/OWNER_GATE_STATUS.md', '| C5 | OUT_OF_SCOPE | ________ |', '| C5 | OUT_OF_SCOPE | 2026-10-02 |'],
    ['docs/OWNER_GATE_STATUS.md', '| P0 payload retention answer | ________ |', '| P0 payload retention answer | covered |'],
    ['docs/OWNER_P0_READINESS.md', '| Listing date | ________ |', '| Listing date | 2026-09-30 |'],
    ['docs/POST_MERGE_OWNER_PACKET.md', '| C5 | ________ |', '| C5 | read 2026-09-30 |'],
    ['docs/DEPLOYMENT_ROLLBACK.md', '| C2 | ________ |', '| C2 | attested |'],
  ])('fails when %s has %s changed to %s', (path, from, to) => {
    const root = copy();
    const text = readFileSync(join(root, path), 'utf8');
    expect(text.split(from)).toHaveLength(2);
    writeFileSync(join(root, path), text.replace(from, to));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(path);
    expect(r.stdout).toBe('');
  });

  it.each([
    ['docs/OWNER_GATE_STATUS.md', 'C2, C3, and C5 are OUT OF SCOPE FOR V1 (not PASSED).'],
    ['docs/OWNER_GATE_STATUS.md', 'Pursuing a Kraken adapter later reopens C2, C3, and C5.'],
    ['docs/OWNER_P0_READINESS.md', '**NOT AUTHORIZED TO RUN.**'],
    ['docs/OWNER_P0_READINESS.md', 'For v1, C2 and C3 are OUT OF SCOPE (not PASSED)'],
    ['docs/POST_MERGE_OWNER_PACKET.md', 'For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED); pursuing a Kraken adapter later reopens them.'],
    ['docs/DEPLOYMENT_ROLLBACK.md', 'For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED).'],
  ])('fails when %s drops "%s"', (path, needle) => {
    const root = copy();
    const text = readFileSync(join(root, path), 'utf8');
    expect(text.split(needle)).toHaveLength(2);
    writeFileSync(join(root, path), text.replace(needle, ''));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${path}: missing "${needle}"`);
    expect(r.stdout).toBe('');
  });

  it.each([
    ['docs/OWNER_GATE_STATUS.md', 'C2 is met.'],
    ['docs/OWNER_GATE_STATUS.md', 'C5 has passed.'],
    ['docs/OWNER_GATE_STATUS.md', 'C3 was cleared.'],
    ['docs/OWNER_P0_READINESS.md', 'P0 is authorized.'],
    ['docs/POST_MERGE_OWNER_PACKET.md', '| Gate | PASSED |'],
    ['docs/DEPLOYMENT_ROLLBACK.md', '| Status | MET |'],
  ])('fails when %s gains "%s"', (path, claim) => {
    const root = copy();
    writeFileSync(join(root, path), `${readFileSync(join(root, path), 'utf8')}\n${claim}\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${path}: states a gate as met, passed or cleared`);
    expect(r.stdout).toBe('');
  });
});
