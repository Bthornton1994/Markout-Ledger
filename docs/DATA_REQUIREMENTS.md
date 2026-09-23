# Synthetic data: limitations, and what a credible evaluation needs

## What the shipped fixtures are

`fixtures/*.jsonl` are produced by `src/market/synthetic.ts`: a seeded random walk with piecewise regimes (drift, volatility, trade probability, seller/buyer bias, probability of a print through the touch), a five-level book with random sizes around it, and modeled feed latency. They are labelled `synthetic: true` with the mandatory label in the header, and the engine refuses a synthetic file whose label was removed.

They exist to make the engine deterministic and testable. They are **not** a market model.

## Why nothing here says anything about profitability

- Prices do not react to our orders. Real quotes attract or repel flow, and a resting bid changes the very trades that would fill it.
- Trade flow is independent of the book beyond a crude aggressor bias. There is no order-flow autocorrelation, no informed-flow structure, no adverse-selection process beyond a drift regime.
- Book sizes are random per snapshot, so `queueAhead` is a placeholder for a real queue-position estimate.
- Volatility, spreads and latency are round numbers chosen for readability, not calibrated.
- The deterministic controller's rules were written to be legible, not to be good. The comparison tables show that steering *changes* behaviour, which is the milestone's claim; whether it *improves* anything is precisely the open research question, and it cannot be answered on generated data.

## Real data required for a credible evaluation

Milestone 2 turns this list into a contract: [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md) selects the feed provisionally (Kraken spot `BTC/USD`, a venue that serves the United States, where this project is operated; Bybit and Binance were rejected because their official pages exclude US users), [M2_DATA_CONTRACT.md](M2_DATA_CONTRACT.md) defines capture, normalization and fixture schema v2 with the venue's per-message book checksum as the integrity gate, and [M2_EVALUATION_PROTOCOL.md](M2_EVALUATION_PROTOCOL.md) separates recorded-market evaluation from fill calibration (item 5 below). Two limits found on the way are recorded rather than worked around: the selected instrument's quantity increment is finer than the engine's fixed point, so either a versioned precision migration or a substitute pair from the owner's instrument listing must come first, a choice made only after that listing ([M2_GROK_HANDOFF.md](M2_GROK_HANDOFF.md) section 0); and the owner's reading of the venue's Global Terms (reported 2026-09-23) found broad restrictions on data extraction and automation and no explicit exception for the public API, so nothing is captured until a written record from the venue or a qualified lawyer concludes that the use is permitted and the owner has confirmed jurisdiction (decision conditions C2 and C3), raw captures never enter this repository, and only hashes and provenance are published unless redistribution is granted in writing.

For a specific venue and instrument, all with capture timestamps:

1. **Full-depth order-book updates with a per-message integrity mechanism** (sequence numbers or a checksum; L2 deltas at minimum; L3 / per-order feeds where the venue offers them). Snapshots every 100 ms lose the intra-interval touches and cancels that decide fills. Sequence numbers or checksums are needed to detect gaps and corruption instead of guessing (the selected Milestone 2 feed has a per-message checksum and no sequence number).
2. **All trades with aggressor side**, trade ids, and the venue timestamp, so prints can be matched to book state and to our own resting price.
3. **Receive-time stamps** (`obsTime`) taken by the capturing process on the same clock the strategy would use, separate from venue/block time. Without them the causality guarantees in this engine are meaningless in evaluation.
4. **For on-chain venues:** block number and block time per event, mempool or sequencer inclusion latency, and the actual gas or fee paid per placement and cancel, so `placementCost` / `cancelCost` can be set from data rather than assumed.
5. **Own-order data for calibrating the queue model:** a period of real (tiny-size) resting orders with acknowledgement time, queue position where the venue reports it, and fill or cancel outcomes. This is the only way to replace "pessimistic back of queue" with a measured fill probability, and to measure real order and cancel latency distributions.
6. **Fee schedule** at the time of capture (maker/taker tiers, rebates), and any post-only or self-match rules.
7. **Enough history to cover regimes**: several sessions spanning calm, trending and volatile periods, including outages or feed gaps, so the stale-observation and rejection paths are exercised on real anomalies.

## Evaluation protocol considerations

- Keep the ledger contract: every decision must cite the observation it used and the instruction version in force.
- Evaluate steered vs unsteered vs no-trade on identical replayed inputs, then report fill-uncertainty counters alongside P&L. A result that depends on fills the queue model cannot justify is not a result.
- Treat the paper execution model as an upper bound on nothing and a lower bound on nothing until the queue and impact assumptions are calibrated against item 5; report both a pessimistic and a "calibrated" fill model side by side once that exists.
- Hold out sessions the controller rules (or a future learned controller) never saw.
