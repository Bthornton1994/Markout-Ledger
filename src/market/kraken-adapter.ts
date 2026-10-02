/**
 * Disabled placeholder for a Kraken venue adapter. There is no Kraken adapter.
 *
 * Markout Ledger v1 is an offline evaluation product: it replays synthetic fixtures and data with documented rights for
 * the intended use, and it opens no connection to any venue. Nothing here performs a network call. Nothing on the
 * default path imports this module: src/cli/main.ts and src/index.ts reach it neither directly nor through another
 * module (tests/v1-offline-boundary.test.ts checks both).
 *
 * Enabling or calling this later reopens C2, C3 and C5 (docs/OWNER_GATE_STATUS.md; the definitions stay in
 * docs/M2_DATA_SOURCE_DECISION.md section 1). For v1 they are OUT OF SCOPE: not passed and not met.
 */

/** False while v1 is the offline product. */
export const KRAKEN_ADAPTER_ENABLED = false;

/** Always throws: KRAKEN_ADAPTER_ENABLED is false, and no adapter exists to open. */
export function openKrakenAdapter(): never {
  throw new Error(
    'Kraken adapter is disabled: Markout Ledger v1 is offline evaluation only (KRAKEN_ADAPTER_ENABLED is false). Enabling or calling it reopens C2, C3 and C5 (docs/OWNER_GATE_STATUS.md).',
  );
}
