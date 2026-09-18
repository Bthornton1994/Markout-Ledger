import { canonicalJson, sha256Hex } from '../core/hash.js';
import { LEDGER_SCHEMA_VERSION, type LedgerEntry, type LedgerEvent, type LedgerEventType } from './types.js';

export const GENESIS_HASH = '0'.repeat(64);

/** Freeze an entry and every plain object/array it contains, so no later mutation can diverge from its hash. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/**
 * Append-only ledger with a SHA-256 hash chain. Entries are frozen on append.
 * An optional sink receives each entry as a JSONL line as soon as it is appended.
 */
export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private lastHash = GENESIS_HASH;
  private lastTime = Number.NEGATIVE_INFINITY;

  constructor(private readonly sink?: (line: string) => void) {}

  append<E extends LedgerEvent>(event: E): LedgerEntry & E {
    if (event.simTime < this.lastTime) {
      throw new Error(`ledger time must not go backwards: ${event.simTime} < ${this.lastTime}`);
    }
    const body = {
      ...event,
      ledgerSeq: this.entries.length,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      prevHash: this.lastHash,
    };
    const hash = sha256Hex(canonicalJson(body));
    const entry = deepFreeze({ ...body, hash }) as LedgerEntry & E;
    this.entries.push(entry);
    this.lastHash = hash;
    this.lastTime = event.simTime;
    if (this.sink) this.sink(JSON.stringify(entry));
    return entry;
  }

  get length(): number {
    return this.entries.length;
  }

  get headHash(): string {
    return this.lastHash;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  ofType<T extends LedgerEventType>(type: T): Array<Extract<LedgerEntry, { type: T }>> {
    return this.entries.filter((e): e is Extract<LedgerEntry, { type: T }> => e.type === type);
  }

  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  /** Recompute the hash chain and confirm every link. */
  static verify(entries: readonly LedgerEntry[]): { ok: true } | { ok: false; at: number; detail: string } {
    let prev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.ledgerSeq !== i) return { ok: false, at: i, detail: `ledgerSeq ${e.ledgerSeq} != ${i}` };
      if (e.prevHash !== prev) return { ok: false, at: i, detail: 'prevHash mismatch' };
      const { hash, ...body } = e;
      const expect = sha256Hex(canonicalJson(body));
      if (hash !== expect) return { ok: false, at: i, detail: 'hash mismatch' };
      prev = hash;
    }
    return { ok: true };
  }
}
