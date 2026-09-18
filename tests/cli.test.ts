import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BASE, Ledger, SYNTHETIC_LABEL, loadFixture, windowsCovered, type LedgerEntry } from '../src/index.js';

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

  function replayFails(out: string, windows: string): { status: number | null; stdout: string; stderr: string } {
    try {
      execFileSync('node_modules/.bin/tsx', ['src/cli/main.ts', 'replay', '--scenario', 'baseline', '--out', out, '--windows', windows], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      return err as { status: number | null; stdout: string; stderr: string };
    }
    throw new Error('expected the replay to fail');
  }

  it('refuses an invalid configuration before creating the output directory or any ledger file', () => {
    const out = mkdtempSync(join(tmpdir(), 'markout-cli-invalid-'));
    const failure = replayFails(out, '0');
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/RangeError: numWindows must be an integer >= 1, got 0/);
    expect(failure.stdout).toBe('');
    expect(existsSync(join(out, 'baseline'))).toBe(false);
  });

  it('refuses a window count beyond the fixture before creating the output directory or any ledger file', () => {
    const out = mkdtempSync(join(tmpdir(), 'markout-cli-overrun-'));
    const covered = windowsCovered(loadFixture('fixtures/synthetic-baseline.jsonl').header, DEFAULT_BASE.windowMs);
    const failure = replayFails(out, String(covered + 1));
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(new RegExp(`RangeError: fixture covers only ${covered} windows, ${covered + 1} requested`));
    expect(failure.stdout).toBe('');
    expect(existsSync(join(out, 'baseline'))).toBe(false);
  });
});
