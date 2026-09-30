// Locks the owner gate status and P0 readiness documents to UNMET and blank owner fields, and proves the offline
// gate-status check passes on this checkout and fails when any C2, C3 or C5 field is filled. It does not loosen or
// replace tests/offline-ops.test.ts, which keeps its own locks on the packet, the rollback document and release prep.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(repo, path), 'utf8').replace(/\r\n/g, '\n');
const script = join(repo, 'scripts', 'gate-status-check.mjs');
const run = (root?: string) => spawnSync(process.execPath, root ? [script, '--root', root] : [script], { encoding: 'utf8' });

const DOCS = ['docs/OWNER_GATE_STATUS.md', 'docs/OWNER_P0_READINESS.md', 'docs/POST_MERGE_OWNER_PACKET.md', 'docs/DEPLOYMENT_ROLLBACK.md'];

describe('owner gate status stays UNMET and blank', () => {
  const status = read('docs/OWNER_GATE_STATUS.md');

  it('marks C2, C3 and C5 UNMET with blank owner fields and claims none of them', () => {
    const rows = status.split('\n').filter((line) => /^\| C[235] \| UNMET \|/.test(line));
    expect(rows).toEqual(['| C2 | UNMET | ________ |', '| C3 | UNMET | ________ |', '| C5 | UNMET | ________ |']);
    expect(status).toContain('C2, C3, and C5 remain UNMET.');
    expect(status).not.toMatch(/\bC[235] is met\b/);
    expect(status).not.toMatch(/\|\s*MET\s*\|/);
  });

  it('names the evidence each gate needs without supplying it', () => {
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

describe('owner P0 readiness is owner only and not authorized', () => {
  const p0 = read('docs/OWNER_P0_READINESS.md');

  it('opens with the not-authorized banner and keeps every precondition and record blank', () => {
    expect(p0.split('\n')[2]).toMatch(/^\*\*NOT AUTHORIZED TO RUN\.\*\* The P0 listing is NOT AUTHORIZED until C2 and C3 are attested/);
    const fills = p0.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| ---') && !/\| Owner fills \|$/.test(line));
    expect(fills.length).toBeGreaterThanOrEqual(9);
    for (const row of fills) expect(row).toMatch(/\| ________ \|$/);
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

  it('passes on this checkout, prints the owner-blocked list, and never states a gate as cleared', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/C2, C3 and C5 are UNMET/);
    for (const gate of ['  C2 ', '  C3 ', '  C5 ']) expect(r.stdout).toContain(gate);
    expect(r.stdout).not.toMatch(/\bmet\b/i);
  });

  const copy = (): string => {
    tmp = mkdtempSync(join(tmpdir(), 'gate-status-'));
    mkdirSync(join(tmp, 'docs'));
    for (const path of DOCS) cpSync(join(repo, path), join(tmp, path));
    return tmp;
  };

  it.each([
    ['docs/OWNER_GATE_STATUS.md', '| C3 | UNMET | ________ |', '| C3 | MET | 2026-09-30 |'],
    ['docs/OWNER_GATE_STATUS.md', '| P0 payload retention answer | ________ |', '| P0 payload retention answer | covered |'],
    ['docs/OWNER_P0_READINESS.md', '| Listing date | ________ |', '| Listing date | 2026-09-30 |'],
    ['docs/POST_MERGE_OWNER_PACKET.md', '| C5 | ________ |', '| C5 | read 2026-09-30 |'],
    ['docs/DEPLOYMENT_ROLLBACK.md', '| C2 | ________ |', '| C2 | attested |'],
  ])('fails when %s has %s filled', (path, blank, filled) => {
    const root = copy();
    const text = readFileSync(join(root, path), 'utf8');
    expect(text.split(blank)).toHaveLength(2);
    writeFileSync(join(root, path), text.replace(blank, filled));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(path);
    expect(r.stdout).toBe('');
  });

  it('fails when the not-authorized banner is dropped', () => {
    const root = copy();
    const path = 'docs/OWNER_P0_READINESS.md';
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace('**NOT AUTHORIZED TO RUN.**', ''));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NOT AUTHORIZED TO RUN');
  });
});
