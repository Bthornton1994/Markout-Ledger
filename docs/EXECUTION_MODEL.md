# Paper execution model

Implementation: `src/execution/paper.ts`. Every assumption below is also written into each ledger's `replay_started.assumptions`.

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

A trade and a cancel are ordered by simulated time; at the same millisecond the scheduler processes market events before order-state transitions, so **the fill wins ties**. This is the pessimistic choice for a passive quoter trying to pull a quote. A cancel that arrives after a full fill is logged as `cancel_too_late`; a fill during a pending cancel is logged as `cancel_fill_race`. `tests/execution.test.ts` and `tests/engine.test.ts` check strictly-before, tie and strictly-after cases and that identical inputs produce identical outcomes. A cancel requested before the order is live cannot take effect before `liveAt`, and an order that is not yet live can never fill.

## Fees and transaction costs

- Maker fee: `makerFeeBps` of the fill notional, rounded up (default 2 bps).
- Fixed placement cost charged on every submission and fixed cancel cost on every cancel request (defaults 0.005 and 0.002 quote), whether or not the order later fills. These stand in for gas or per-message venue charges on an on-chain or metered venue; set them to zero for a venue without them.

## Not modeled (stated limitations)

- Market impact: our orders are not inserted into the replayed book and the replayed trades are unaffected by our presence.
- Fill notification latency: the portfolio updates at the trade's `obsTime`.
- Variable or random latency, venue outages, self-match prevention, hidden liquidity, iceberg orders, rebates.
- Any taker execution, including liquidation of the end-of-run inventory.
