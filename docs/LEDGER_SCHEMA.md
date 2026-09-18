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
- `observation_rejected`: `reason`, `detail`, `phase`, `encounteredAt` (see EVENT_SCHEMA.md). Appended when the event is encountered in stream order, so `simTime` is never earlier than the decisions that preceded the event.

Fast policy

- `policy_decision`: one per tick. `instructionVersion` and `instructionEffectiveFrom` of the instruction the policy used; `input` (book event id and obsTime, book age, top of book, inventory, resting orders); `decision` (`quote | hold | pull`, desired bid/ask, reason); `policyError` if the policy threw (the decision is then forced to `pull`).

Orders and execution (one entry per state transition)

- `order_proposed`: the policy's desired quote after reconciling with resting orders.
- `order_rejected`: `rejectedBy: risk_gate | venue`, `reason`, `detail`. Risk reasons: `kill_switch_active`, `order_size_limit`, `invalid_qty`, `invalid_price`, `position_limit`. Venue reasons: `post_only_would_cross`, `no_book`.
- `order_submitted`: `orderId`, `expectedLiveAt`, `placementCost`.
- `order_live`: `liveAt` (venue time), `queueAhead`, `queueSource`, the book event used with its `bookMarketTime` and `bookLagMs`, and the fill-uncertainty note.
- `cancel_requested`: `expectedEffectiveAt`, `cancelCost`, reason (`requote | withdraw | pull | kill_switch`).
- `cancel_effective` (with `finalAt`: until then the cancel is provisional and a late fill can still arrive), `cancel_too_late` (`already_filled | already_cancelled | already_rejected`).
- `cancel_fill_race`: a trade filled an order with a cancel in flight or already effective; `outcome: fill_wins_before_cancel | fill_wins_tie | late_fill_after_cancel_effective`, `tradeMarketTime`, `tradeObsTime`, and the rule.
- `fill`: `fillId`, qty, price, notional, fee, `isPartial`, `fillType` (`trade_through | queue_exhausted`), `queueAheadBefore`, the **source print** that filled us in venue order (`sourceTradeEventId`, `sourceTradePrice`, `sourceTradeSize`, `sourceMarketTime`; qty never exceeds the source size), the print whose observation **established** it (`establishedByTradeEventId`, `establishedByReordering`), `observedAt` (when it was booked, == `simTime`), `duringCancelPending`, `afterCancelEffective`, `realizedDelta`, `inventoryAfter`, `cashAfter`.
- `fill_reattributed`: already-booked quantity whose venue-order source changed because an earlier print was observed later; `fillId`, `fromPortionId` / `toPortionId`, `qty`, `fromTradeEventId` / `fromMarketTime`, `toTradeEventId` / `toMarketTime`, `establishedByTradeEventId`, `observedAt`, `outcomesRebased` (horizons re-run from the new source) and `outcomesKept` (horizons that had already been measured; always empty under the validated configuration, which requires every horizon to be at least `maxStalenessMs`). No accounting effect.
- `fill_ineligible`: a print at or through our price that could not have filled us on venue time; `reason: predates_activation | at_activation_instant | after_cancellation`, both trade timestamps, `orderLiveAt`, `cancelEffectiveAt`.
- `fill_uncertain`: a print discarded as stale that was eligible for this order on venue time; nothing awarded; `reason: stale_print_discarded`, `lagMs`, both trade timestamps. Appended right after the `observation_rejected` entry it stems from.
- `queue_consumed`: a print at our price was absorbed by the displayed queue ahead of us in venue order; no fill awarded; `queueAheadBefore`, `queueAheadAfter`.
- `tx_cost`: `kind: placement | cancel`, amount, `cashAfter`.

Outcomes and risk

- `outcome`: markout of a fill portion at `horizonMs` (`fillId`, `portionId`, `sourceTradeEventId`). The horizon runs on the source print's venue time: `availableAt = max(sourceMarketTime + horizonMs, observedAt)`. The mid is the latest observed book whose `marketTime` does not exceed the horizon (`midSelection: venue_time`; `midMarketTime`, `midObsTime`, `midEventId`), falling back to the latest observed book if none qualifies; `status: measured | unmeasurable_no_book | superseded_by_reattribution` (the portion's quantity moved to another source before this horizon elapsed; not counted).
- `risk_breach`: `kind: loss_limit` (kill switch tripped) or `position_overrun` (a fill, typically a late fill on a provisionally cancelled order, pushed inventory past the position limit; no kill switch, increasing orders are rejected from then on).

Slow controller

- `window_summary`: per-window counters, instruction versions used, parameters in effect at the end, net P&L, inventory.
- `controller_input`: the exact `WindowReview` handed to the controller.
- `controller_output`: the proposal as returned, `simulatedLatencyMs`, `readyAt`.
- `instruction_accepted`: the validated instruction, `readyAt`, `deadlineAt`, `appliesFrom = max(effectiveFrom, readyAt)`.
- `instruction_rejected`: `reason: late | controller_failed | invalid`, `detail`, `keptInstructionVersion`.
- `controller_skipped`: `steering_disabled` or `no_next_window`.

## Rebuilding state from the ledger

The reconciliation test (`tests/engine.test.ts`, "net P&L reconciles") shows the pattern: fold `fill` and `tx_cost` entries to rebuild cash, inventory, fees, transaction costs and gross realized P&L, then compare with the summary. Every order's lifecycle is the sequence `order_proposed -> (order_rejected | order_submitted -> (order_rejected | order_live -> (fill | fill_reattributed)* -> (fill(final) | cancel_effective -> fill(afterCancelEffective)*)))` and can be reassembled by `orderId`. A `cancel_effective` is provisional until its `finalAt`. Accounting is rebuilt from `fill` and `tx_cost` alone; `fill_reattributed` changes provenance only.
