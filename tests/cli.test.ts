import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, SYNTHETIC_LABEL, type LedgerEntry } from '../src/index.js';

describe('cli', () => {
  it('replays a scenario, prints the synthetic label, and writes results + verifiable ledgers', () => {
    const out = mkdtempSync(join(tmpdir(), 'markout-cli-'));
    const stdout = execFileSync('node_modules/.bin/tsx', ['src/cli/main.ts', 'replay', '--scenario', 'baseline', '--out', out, '--windows', '4'], { encoding: 'utf8' });
    expect(stdout).toContain(SYNTHETIC_LABEL);
    expect(stdout).toContain('Run comparison');
    expect(stdout).toMatch(/no_trade\s+0/);
    const results = JSON.parse(readFileSync(join(out, 'baseline', 'results.json'), 'utf8'));
    expect(results.syntheticLabel).toBe(SYNTHETIC_LABEL);
    expect(Object.keys(results.runs).sort()).toEqual(['no_trade', 'steered', 'unsteered']);
    expect(results.runs.steered.windows).toBe(4);
    for (const kind of ['no_trade', 'unsteered', 'steered']) {
      const path = join(out, 'baseline', `${kind}.ledger.jsonl`);
      expect(existsSync(path)).toBe(true);
      const entries = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEntry);
      expect(Ledger.verify(entries)).toEqual({ ok: true });
      expect(entries[0]!.type).toBe('replay_started');
      expect(entries[entries.length - 1]!.type).toBe('replay_finished');
      expect(entries.length).toBe(results.runs[kind].ledger.entries);
    }
  });
});
