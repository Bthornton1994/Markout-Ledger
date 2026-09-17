import { describe, expect, it } from 'vitest';
import { Ledger, GENESIS_HASH, type LedgerEntry } from '../src/index.js';

describe('append-only ledger', () => {
  it('chains hashes and detects tampering', () => {
    const lines: string[] = [];
    const l = new Ledger((line) => lines.push(line));
    l.append({ type: 'controller_skipped', simTime: 1, window: 0, reason: 'steering_disabled', instructionVersion: 0 });
    l.append({ type: 'controller_skipped', simTime: 2, window: 1, reason: 'steering_disabled', instructionVersion: 0 });
    const entries = l.all();
    expect(entries[0]!.prevHash).toBe(GENESIS_HASH);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(Ledger.verify(entries)).toEqual({ ok: true });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).hash).toBe(entries[1]!.hash);

    const tampered = entries.map((e) => ({ ...e })) as LedgerEntry[];
    (tampered[0] as { window: number }).window = 99;
    expect(Ledger.verify(tampered)).toMatchObject({ ok: false, at: 0 });
  });

  it('freezes entries and refuses to go back in time', () => {
    const l = new Ledger();
    const e = l.append({ type: 'controller_skipped', simTime: 5, window: 0, reason: 'steering_disabled', instructionVersion: 0 });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => l.append({ type: 'controller_skipped', simTime: 4, window: 1, reason: 'steering_disabled', instructionVersion: 0 })).toThrow(/backwards/);
  });
});
