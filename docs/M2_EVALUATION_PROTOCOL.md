# Milestone 2: recorded-market evaluation is not fill calibration

This document fixes what a replay of recorded market observations can and cannot establish, how fill assumptions are reported, and when a result must be called inconclusive. It applies to every run on a `synthetic: false` fixture produced under [M2_DATA_CONTRACT.md](M2_DATA_CONTRACT.md).

## 1. Two separate questions

| question | inputs | what answers it |
|---|---|---|
| **Recorded-market evaluation.** On real order flow, does steering change the paper outcome relative to the unsteered policy and the no-trade baseline, under a stated fill model? | recorded observations with genuine receive timestamps; the paper execution model with its assumptions written into `replay_started.assumptions` | replaying `no_trade`, `unsteered`, `steered` on identical input, reported alongside the fill-uncertainty counters |
| **Fill calibration.** How do real resting orders on this venue actually get acknowledged, queued, filled and cancelled? | our own tiny-size orders with venue acknowledgements, queue position where reported, fill and cancel outcomes, measured latencies | a measured fill model, which does not exist yet |

Paper P&L is a function of assumed fills. Without own-order acknowledgements and fills, **no paper P&L figure in this repository establishes profitability**, and no report may say otherwise. The M1 claim, "steering changes behaviour", is testable on recorded data; "steering is profitable" is not, until calibration data exists (DATA_REQUIREMENTS.md, item 5). Milestone 2 does not place orders and produces no calibration data.

## 2. The fill-assumption sensitivity report

Every recorded-session result is reported as a grid, never as a single number. The grid re-runs the same three run kinds on the same fixture under each assumption set; fixture content hash, ledger head hashes and the assumption set are printed with every row.

Dimensions available without changing the matcher (all are `ReplayConfig` / `ExecutionConfig` fields, see REPLAY.md "Configuration limits"):

| dimension | values | why |
|---|---|---|
| `execution.orderLatencyMs` / `execution.cancelLatencyMs` | 0, 50, 150, 500 ms (paired) | activation and cancel instants decide venue-time eligibility; fixed constants stand in for a distribution we have not measured |
| `maxStalenessMs` | 200, 500, 1000 ms (outcome horizons kept `>=` it) | decides which prints are discarded as stale and how wide the reordering window is |
| `execution.makerFeeBps` | 0 and the venue's published maker rate for the lowest tier at capture time | fee tier is unknown for an account that does not exist |
| `execution.placementCost` / `execution.cancelCost` | 0 and the venue's per-message cost if any (gas on an on-chain venue) | messaging costs dominate a requoting policy |
| queue model | `back_of_queue` (the only model in M1; pessimistic) | a `front_of_queue` optimistic bound is a follow-up change to `src/execution/paper.ts` and is **not** part of the smallest M2 PR; until it exists the report states that only the pessimistic bound was run |

Columns per row (all already in `RunSummary`): `portfolio.netPnl`, `portfolio.grossRealized`, `portfolio.feesPaid`, `portfolio.txCostsPaid`, `fills.count`, `fills.qty`, `fills.uncertain`, `fillUncertainty.queueConsumedWithoutFill`, `fills.lateAfterCancel`, `fills.ineligible`, `outcomes[*].avgMarkoutBps` and `count`, `orders.rejectedByRisk`, `risk.killSwitchTripped`, `observations.rejected`, `outcomesPendingAtEnd`.

Derived per session and assumption set: `steered - unsteered` and `steered - no_trade` net P&L, and the same differences for the shortest-horizon markout.

Fill uncertainty is part of the result, not a footnote: a row whose `fills.uncertain` or `queueConsumedWithoutFill` is large is a row the data could not decide.

## 3. Held-out session protocol

1. **Session unit.** One session = one contiguous, gap-free capture segment (contract §6) of at least 60 minutes, from a capture host with a recorded clock-sync report, normalized to one fixture with one content hash.
2. **Development set.** Sessions used while writing or tuning policy parameters, controller rules or fill assumptions. Anything inspected before the rule set is frozen is development data, whatever it was intended to be.
3. **Freeze.** Before any held-out session is *captured*, commit to the repository: the exact policy and controller versions (commit hash), the assumption grid, the metrics, and the decision rule below. The commit hash is the pre-registration timestamp.
4. **Held-out set.** At least 3 sessions captured after the freeze, on at least 3 distinct calendar days, including at least one session whose realized volatility (from the fixture's own mids) is in the top or bottom quartile of all sessions captured so far. Held-out fixtures are replayed once per grid cell and never used to change anything; if a change is made afterwards, the sessions become development data and new held-out sessions are needed.
5. **Statistic.** For each held-out session and grid cell, the paired per-window difference `steered - unsteered` of the chosen metric (net P&L, and separately shortest-horizon markout) over the session's windows. Report the mean paired difference per session and its 90% bootstrap interval over windows, and the sign agreement across sessions and grid cells.

## 4. When the result is inconclusive (explicit criteria)

A recorded-market evaluation is **inconclusive**, and must be reported as such, if any of the following holds:

| code | criterion |
|---|---|
| I1 | The sign of the mean `steered - unsteered` net P&L difference is not the same across all cells of the assumption grid for the same session (the conclusion depends on an unmeasured assumption). |
| I2 | In any run, `fills.uncertain` exceeds 5% of `fills.count`, or the notional of stale-discarded eligible prints exceeds the absolute net P&L difference being reported. |
| I3 | `fillUncertainty.queueConsumedWithoutFill` exceeds `fills.count` in the steered or unsteered run (most touches were decided by the queue guess, not by prints). |
| I4 | Fewer than 30 fills in the steered or unsteered run of a session, or fewer than 3 held-out sessions, or held-out sessions on fewer than 3 distinct days. |
| I5 | The 90% bootstrap interval of the mean paired difference contains zero in a majority of held-out sessions. |
| I6 | The session's capture quality is below contract limits: any gap or clock cut inside the segment, `observations.rejected` above 1% of accepted, capture lag p99 above `maxStalenessMs`, or a missing clock-sync report. |
| I7 | The kill switch tripped in either trading run (the comparison is then between a stopped run and a running one). |

A conclusive result is stated as: "on N held-out sessions of venue/instrument, under assumption grid G, steering changed net paper P&L by X (interval) relative to the unsteered policy; the pessimistic queue model was the only fill model run; this is not evidence of profitability". Nothing stronger is admissible until fill calibration data exists.

## 5. What Milestone 2 changes and what it does not

- Adds: recorded observations with genuine receive timestamps, the sensitivity grid, the held-out protocol.
- Does not add: own-order data, a calibrated queue model, market impact, or any statement about live profitability. The execution model's stated limitations (EXECUTION_MODEL.md, "Remaining uncertainty" and "Not modeled") all still apply.
