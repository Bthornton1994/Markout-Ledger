# Decision ledger schema

The ledger (`src/ledger/`) is append-only and hash-chained. Every entry is frozen on append, written to JSONL immediately when a sink is attached, and carries:

| field | meaning |
|---|---|
| `ledgerSeq` | dense 0-based position |
| `schemaVersion` | ledger schema version (1) |
| `simTime` | simulated clock (ms epoch) when the entry was appended; never decreases |
| `type` | discriminator (below) |
| `prevHash`, `hash` | SHA-256 over the canonical JSON of the entry (sorted keys) chained to the previous entry; genesis is 64 zeros |

`Ledger.verify(entries)` recomputes the chain. Money, price and quantity fields are decimal strings with six places; parse them with `parseMoney` / `parsePrice` / `parseQty`. Wall-clock timings are deliberately excluded so two replays of the same inputs produce byte-identical ledgers.

## Event types

Run lifecycle

- `replay_started`: run id, label, synthetic flag and label, fixture provenance and content hash, the full engine/policy/risk/execution configuration, and the list of execution assumptions.
- `replay_finished`: the run summary (same object as in `results.json`).

Observations

- `observation`: an accepted observation in compact form (top of book or the print), with `obsTime`, `marketTime`, `feedLagMs`.
- `observation_rejected`: `reason`, `detail`, `phase` (see EVENT_SCHEMA.md).

Fast policy

- `policy_decision`: one per tick. `instructionVersion` and `instructionEffectiveFrom` of the instruction the policy used; `input` (book event id and obsTime, book age, top of book, inventory, resting orders); `decision` (`quote | hold | pull`, desired bid/ask, reason); `policyError` if the policy threw (the decision is then forced to `pull`).

Orders and execution (one entry per state transition)

- `order_proposed`: the policy's desired quote after reconciling with resting orders.
- `order_rejected`: `rejectedBy: risk_gate | venue`, `reason`, `detail`. Risk reasons: `kill_switch_active`, `order_size_limit`, `invalid_qty`, `invalid_price`, `position_limit`. Venue reasons: `post_only_would_cross`, `no_book`.
- `order_submitted`: `orderId`, `expectedLiveAt`, `placementCost`.
- `order_live`: `liveAt`, `queueAhead`, `queueSource`, the book event used, and the fill-uncertainty note.
- `cancel_requested`: `expectedEffectiveAt`, `cancelCost`, reason (`requote | withdraw | pull | kill_switch`).
- `cancel_effective`, `cancel_too_late` (`already_filled | already_cancelled | already_rejected`).
- `cancel_fill_race`: a trade filled an order whose cancel was pending; `outcome: fill_wins` and the rule.
- `fill`: `fillId`, qty, price, notional, fee, `isPartial`, `fillType` (`trade_through | queue_exhausted`), `queueAheadBefore`, the trade that caused it, `realizedDelta`, `inventoryAfter`, `cashAfter`.
- `queue_consumed`: a print at our price was absorbed by the displayed queue ahead of us; no fill awarded.
- `tx_cost`: `kind: placement | cancel`, amount, `cashAfter`.

Outcomes and risk

- `outcome`: markout of a fill at `horizonMs`, measured at `availableAt = fillTime + horizonMs` against the latest valid mid; `status: measured | unmeasurable_no_book`.
- `risk_breach`: the loss-limit kill switch tripped; net P&L, limit, action taken.

Slow controller

- `window_summary`: per-window counters, instruction versions used, parameters in effect at the end, net P&L, inventory.
- `controller_input`: the exact `WindowReview` handed to the controller.
- `controller_output`: the proposal as returned, `simulatedLatencyMs`, `readyAt`.
- `instruction_accepted`: the validated instruction, `readyAt`, `deadlineAt`, `appliesFrom = max(effectiveFrom, readyAt)`.
- `instruction_rejected`: `reason: late | controller_failed | invalid`, `detail`, `keptInstructionVersion`.
- `controller_skipped`: `steering_disabled` or `no_next_window`.

## Rebuilding state from the ledger

The reconciliation test (`tests/engine.test.ts`, "net P&L reconciles") shows the pattern: fold `fill` and `tx_cost` entries to rebuild cash, inventory, fees, transaction costs and gross realized P&L, then compare with the summary. Every order's lifecycle is the sequence `order_proposed -> (order_rejected | order_submitted -> (order_rejected | order_live -> fill* -> (fill(final) | cancel_effective)))` and can be reassembled by `orderId`.
