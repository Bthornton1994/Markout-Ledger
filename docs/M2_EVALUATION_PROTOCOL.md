# Milestone 2: recorded-market evaluation is not fill calibration

This document fixes what a replay of recorded market observations can and cannot establish, how fill assumptions are reported, and when a result must be called inconclusive. It applies to every run on a `synthetic: false` fixture produced under [M2_DATA_CONTRACT.md](M2_DATA_CONTRACT.md).

## 1. Two separate questions

| question | inputs | what answers it |
|---|---|---|
| **Recorded-market evaluation.** On real order flow, does steering change the paper outcome relative to the unsteered policy and the no-trade baseline, under a stated fill model? | recorded observations with genuine receive timestamps; the paper execution model, whose textual assumptions are in `replay_started.assumptions` and whose numeric ones are in `replay_started.config` | replaying `no_trade`, `unsteered`, `steered` on identical input, reported alongside the fill-uncertainty counters |
| **Fill calibration.** How do real resting orders on this venue actually get acknowledged, queued, filled and cancelled? | our own tiny-size orders with venue acknowledgements, queue position where reported, fill and cancel outcomes, measured latencies | a measured fill model, which does not exist yet |

Paper P&L is a function of assumed fills. Without own-order acknowledgements and fills, **no paper P&L figure in this repository establishes profitability**, and no report may say otherwise. The M1 claim, "steering changes behaviour", is testable on recorded data; "steering is profitable" is not, until calibration data exists (DATA_REQUIREMENTS.md, item 5). Milestone 2 does not place orders and produces no calibration data.

## 2. The fill-assumption sensitivity report

Every recorded-session result is reported as a grid, never as a single number. The grid re-runs the same three run kinds on the same fixture under each assumption set; the fixture content hash, the ledger head hashes and the assumption set (read from that run's `replay_started.config`, or carried by the grid tool from its own inputs) are printed with every row. The smallest M2 PR produces no grid: its real-session table (handoff A12) is one cell under the recorded scenario's defaults and is labelled a mechanics check, inconclusive by construction (I1 unevaluated, I4 unmet). The grid is produced with `replay()` in a later PR (REPLAY.md, "Programmatic use").

Dimensions, all `ReplayConfig` / `ExecutionConfig` fields (REPLAY.md "Configuration limits"):

| dimension | values | why |
|---|---|---|
| `execution.orderLatencyMs` / `execution.cancelLatencyMs` | 0, 50, 150, 500 ms (paired) | activation and cancel instants decide venue-time eligibility; fixed constants stand in for a distribution we have not measured |
| `maxStalenessMs` | 200, 500, 1000 ms (outcome horizons kept `>=` it) | decides which prints are discarded as stale and how wide the reordering window is |
| `execution.makerFeeBps` | 0 and the venue's published maker rate for the lowest tier at capture time | the fee tier of an account that does not exist is unknown |
| `execution.placementCost` / `execution.cancelCost` | 0 and the venue's per-message cost if any (gas on an on-chain venue) | messaging costs dominate a requoting policy |

The queue model is not a field: every run reports the constant `pessimistic_back_of_queue` (`fillUncertainty.model`, `replay_started.config.execution.queueModel`). An optimistic bound (`optimistic_front_of_queue`) is a follow-up change to `src/execution/paper.ts`, not part of the smallest M2 PR; until it exists the report states that only the pessimistic bound was run.

Columns per row (all in `RunSummary`, i.e. `results.json` `runs.<kind>`): `portfolio.netPnl`, `portfolio.grossRealized`, `portfolio.feesPaid`, `portfolio.txCostsPaid`, `fills.count`, `fills.qty`, `fills.uncertain`, `fillUncertainty.queueConsumedWithoutFill`, `fills.lateAfterCancel`, `fills.ineligible`, `outcomes[*].avgMarkoutBps` and `count`, `orders.rejectedByRisk`, `risk.killSwitchTripped`, `observations.rejected`, `outcomesPendingAtEnd`; plus the per-run `config` block that the M2 build adds to `results.json`.

Derived per session and assumption set: `steered - unsteered` and `steered - no_trade` net P&L, and the same differences for the shortest-horizon markout.

Fill uncertainty is part of the result, not a footnote: a row whose `fills.uncertain` or `queueConsumedWithoutFill` is large is a row the data could not decide.

## 3. Held-out session protocol

1. **Session unit.** One session = one segment (contract §5.8) of at least 60 minutes whose `endReason` is `capture_end`, `gap_sequence`, `gap_disconnect` or `clock_cut` (a segment cut by `reconstruction_failure` or `malformed_depth` is not admissible), from a capture host with a recorded clock-sync report, normalized to one fixture with one content hash.
2. **Development set.** Sessions used while writing or tuning policy parameters, controller rules or fill assumptions. Anything inspected before the rule set is frozen is development data, whatever it was intended to be.
3. **Freeze.** Before any held-out session is *captured*, commit to the repository: the exact policy and controller versions (commit hash), the assumption grid, the metrics, and the decision rule below. The commit hash is the pre-registration timestamp.
4. **Held-out set.** At least 3 sessions captured after the freeze, on at least 3 distinct calendar days, including at least one session whose realized volatility (from the fixture's own mids) is in the top or bottom quartile of all sessions captured so far. Held-out fixtures are replayed once per grid cell and never used to change anything; if a change is made afterwards, the sessions become development data and new held-out sessions are needed.
5. **Statistic.** Per-window net P&L is the increment `windowRows[k].netPnl - windowRows[k-1].netPnl` (with `windowRows[0].netPnl` for `k = 0`; `WindowRow.netPnl` itself is the cumulative valuation at the window end). `windowRows[k].markoutShortest` is already per window. For each held-out session and grid cell, form the paired per-window difference `steered - unsteered` of each metric. Increments are serially dependent (an outcome horizon of 3 s spans a window boundary), so the interval is a **block bootstrap** over windows with block length at least `ceil(max(outcomeHorizonsMs) / windowMs) + 1` (2 for the recorded scenario). Report the mean paired difference per session, its 90% block-bootstrap interval, and the sign agreement across sessions and grid cells.

## 4. When the result is inconclusive (explicit criteria)

I6 is evaluated per grid cell and a failing cell is dropped from the grid and reported as dropped; I1 is judged over the remaining cells and needs at least 4 of them. A recorded-market evaluation is **inconclusive**, and must be reported as such, if any of the following holds:

| code | criterion |
|---|---|
| I1 | The sign of the mean `steered - unsteered` net P&L difference is not the same across all remaining cells of the assumption grid for the same session (the conclusion depends on an unmeasured assumption), or fewer than 4 cells remain. |
| I2 | In any run, `fills.uncertain` exceeds 5% of `fills.count`, or the summed size of stale-discarded eligible prints (each `fill_uncertain` ledger entry joined by `tradeEventId` to the fixture's trade event; the rejected observation carries no size in the ledger) exceeds 5% of `fills.qty`. |
| I3 | `fillUncertainty.queueConsumedWithoutFill` exceeds `fills.count` in the steered or unsteered run (most touches were decided by the queue guess, not by prints). |
| I4 | Fewer than 30 fills in the steered or unsteered run of a session, or fewer than 3 held-out sessions, or held-out sessions on fewer than 3 distinct days. |
| I5 | The 90% block-bootstrap interval of the mean paired difference contains zero in a majority of held-out sessions. |
| I6 | Capture quality (per cell): the trade-stream `lagStatsMs.p99` exceeds the cell's `maxStalenessMs`; `observations.rejected` exceeds 1% of `observations.accepted`; `clockSync` is `unknown`; `venueClockOffsetMs.medianMs` exceeds 25 ms in absolute value. |
| I7 | The kill switch tripped in either trading run (the comparison is then between a stopped run and a running one). |

A conclusive result is stated as: "on N held-out sessions of venue/instrument, under assumption grid G, steering changed net paper P&L by X (interval) relative to the unsteered policy; the pessimistic queue model was the only fill model run; this is not evidence of profitability". Nothing stronger is admissible until fill calibration data exists.

## 5. What Milestone 2 changes and what it does not

- Adds: recorded observations with genuine receive timestamps, the sensitivity grid, the held-out protocol.
- Does not add: own-order data, a calibrated queue model, market impact, or any statement about live profitability. The execution model's stated limitations (EXECUTION_MODEL.md, "Remaining uncertainty" and "Not modeled") all still apply.
