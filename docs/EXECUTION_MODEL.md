# Paper execution model

Implementation: `src/execution/paper.ts`. Every assumption below is also written into each ledger's `replay_started.assumptions`.

## Time semantics: venue time decides eligibility, observation time decides knowledge

Every trade carries two timestamps (see EVENT_SCHEMA.md): `marketTime` (when the print happened on the venue) and `obsTime` (when the strategy learned about it). Orders live on the venue clock: `liveAt = submit + orderLatencyMs` and `cancelEffectiveAt = max(request + cancelLatencyMs, liveAt)` are venue instants, assumed to be on the same time base as `marketTime`.

The exchange matches a trade **when it is observed** (at `obsTime`, which is when the portfolio and the policy learn of any fill), but decides **whether it could have filled on venue time**:

```
eligible  <=>  liveAt < trade.marketTime <= cancelEffectiveAt      (cancelEffectiveAt = +inf while no cancel is requested)
```

| case | venue vs order | decision | ledger |
|---|---|---|---|
| print before activation, observed after | `marketTime < liveAt`, `obsTime >= liveAt` | no fill | `fill_ineligible(predates_activation)` |
| print at the activation instant | `marketTime == liveAt` | no fill; ordering unknown at ms resolution | `fill_ineligible(at_activation_instant)` |
| print while live, observed while live | in window | fill | `fill` |
| print while live, observed after the cancel took effect | in window, `obsTime > cancelEffectiveAt` | **late fill**: the cancel is treated as rejected for that quantity; booked at `obsTime` | `cancel_fill_race(late_fill_after_cancel_effective)` + `fill(afterCancelEffective: true)` |
| print at the cancel instant | `marketTime == cancelEffectiveAt` | fill wins the tie | `cancel_fill_race(fill_wins_tie)` + `fill` |
| print after the cancel took effect | `marketTime > cancelEffectiveAt` | no fill | `fill_ineligible(after_cancellation)` |
| eligible print observed after finalization | `obsTime > cancelEffectiveAt + maxTradeLagMs` | cannot be established; **not awarded** | `fill_uncertain(observed_after_finalization)` |

A cancelled order is therefore *provisional* until `finalAt = cancelEffectiveAt + maxTradeLagMs` (recorded in `cancel_effective`). The engine sets `maxTradeLagMs` to its observation staleness limit (`maxStalenessMs`, default 500 ms), so any trade lagging more than that is rejected as stale before it reaches the exchange; the `fill_uncertain` path exists so the exchange stays honest if it is ever driven with a looser feed. Ineligible prints never consume `queueAhead` either.

Late fills matter for risk: the risk gate charges exposure for orders the strategy considers open (pending, live, cancel in flight), **not** for provisionally cancelled ones. A late fill can therefore push inventory past the position limit after a replacement order was already accepted. The engine logs that as `risk_breach(position_overrun)` (no kill switch) and the gate rejects any further increasing order until inventory is reduced. Counting provisional orders as exposure would block a quoter for `maxTradeLagMs` after every requote and was judged too blunt; the trade-off is documented rather than hidden.

Remaining uncertainty in this model, stated plainly:

- `liveAt` and `cancelEffectiveAt` are modeled constants, not observed venue acknowledgements. Real activation and cancel times are distributions.
- The queue estimate at `liveAt` uses the latest *observed* book, whose venue time precedes `liveAt` by the feed lag (`order_live.bookLagMs`). Prints between that book's venue time and `liveAt` are ineligible for us but may have thinned the level; the estimate is therefore pessimistic by up to that much.
- Fill notification latency is folded into the trade's observation lag; a real venue would acknowledge a fill on its own clock.
- Tie handling at millisecond resolution is a rule, not knowledge: at activation the fill is withheld, at cancellation it is awarded. Both are the adverse choice for a passive quoter.

## Order lifecycle

```
submit(t)  -> pending -> live at t + orderLatencyMs -> [fills] -> filled
                                      \-> cancel_pending at request -> cancelled at max(request + cancelLatencyMs, liveAt)
live-time checks: no valid book -> rejected(no_book); would cross the touch -> rejected(post_only_would_cross)
```

Defaults: order latency 50 ms, cancel latency 50 ms (both fixed, in simulated time). Orders are post-only limit orders; there is no taker path.

## Queue model: pessimistic back-of-queue

L2 snapshots do not reveal queue position, so the model assumes the worst plausible case:

- When an order goes live, `queueAhead` = displayed size at our exact price level in the latest valid book (0 if the level is absent, e.g. we improve the touch or sit between levels). The book event used is recorded in `order_live`.
- `queueAhead` decreases **only** through printed trades at our price. Book snapshots never reduce it: a shrinking level could be cancels behind us.
- A trade at our price with size `s`: if `s <= queueAhead`, it is absorbed (`queue_consumed`, no fill); otherwise we fill `min(remaining, s - queueAhead)`.
- A trade **through** our price (better than our level) fills `min(remaining, s)`. Price priority implies our level was swept, but the fill is still capped at the print size.
- A **book touch never fills.** The best ask moving onto or through our bid without a print does nothing.
- Prints whose aggressor is on our side (a `buy` print at or below our bid) are ignored as inconsistent with us resting there. `unknown` aggressor prints count.
- Partial fills are natural consequences of the rules above; the remainder keeps resting with `queueAhead = 0`.
- Multiple own orders on a side share a print in price-time priority.

Fill uncertainty is reported, not hidden: every `order_live` carries the uncertainty note, every `fill` records `queueAheadBefore` and `fillType`, `queue_consumed` entries count prints at our price that did not fill, and the summary exposes `fillUncertainty.queueConsumedWithoutFill`.

## Cancel / fill race

A trade and a cancel are ordered on **venue time**: the trade fills if `marketTime <= cancelEffectiveAt`, so **the fill wins ties**, the pessimistic choice for a passive quoter trying to pull a quote. A cancel that arrives after a full fill is logged as `cancel_too_late`; a fill during a pending cancel is logged as `cancel_fill_race` with outcome `fill_wins_before_cancel` or `fill_wins_tie`; a fill observed only after the cancel took effect is `late_fill_after_cancel_effective` (see the table above). `tests/execution.test.ts` and `tests/engine.test.ts` check strictly-before, tie and strictly-after cases on both clocks and that identical inputs produce identical outcomes. A cancel requested before the order is live cannot take effect before `liveAt`, and an order that is not yet live can never fill.

## Fees and transaction costs

- Maker fee: `makerFeeBps` of the fill notional, rounded up (default 2 bps).
- Fixed placement cost charged on every submission and fixed cancel cost on every cancel request (defaults 0.005 and 0.002 quote), whether or not the order later fills. These stand in for gas or per-message venue charges on an on-chain or metered venue; set them to zero for a venue without them.

## Not modeled (stated limitations)

- Market impact: our orders are not inserted into the replayed book and the replayed trades are unaffected by our presence.
- Fill notification latency beyond the trade's observation lag: the portfolio updates at the trade's `obsTime`.
- Variable or random latency, venue outages, self-match prevention, hidden liquidity, iceberg orders, rebates.
- Any taker execution, including liquidation of the end-of-run inventory.
