# Milestone 2 build handoff: the smallest implementation PR

This is the bounded build task for the implementer (Grok). It implements [M2_DATA_CONTRACT.md](M2_DATA_CONTRACT.md) for the feed selected in [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md), **Bybit spot BTCUSDT** (adapter `bybit-spot-v5`, contract §8; the Binance alternate in §8.6 is not part of this PR), and nothing else. Section 5 is the paste-ready prompt.

## 1. Scope of the PR (in)

| # | deliverable | where |
|---|---|---|
| S1 | **Raw capture tool**, market data only: connects to the selected venue's public WebSocket, subscribes to the book and trade streams of one instrument, performs the venue's snapshot procedure over public REST, and writes raw capture format v1 (contract §4) with both receive clocks per record, file rotation, per-file SHA-256, manifest with the clock-sync report. Uses Node 22's built-in `WebSocket` and `fetch`; no new runtime dependency. | `src/capture/` (`runner.ts`, `adapters/<venue>.ts`), CLI `capture` |
| S2 | **Normalizer**: raw capture v1 to fixture schema v2 (contract §5): adapter decode, book synchronization and full-book reconstruction, per-update `book` emission of the top `depth` levels, trades with aggressor side, duplicates, gaps, reconnection segments, clock-step cuts, lag statistics, rejection rules R1 to R8, normalize report sidecar. Pure and deterministic. | `src/normalize/`, CLI `normalize` |
| S3 | **Schema v2** in the engine's fixture code: `FIXTURE_SCHEMA_VERSION = 2`, loader accepts 1 and 2, header validation per contract §6.4, optional event fields `venueSeq`, `rawRef`, `recvWallNs` round-trip through `toWire`/`fromWire` and are covered by `fixtureContentHash`. Existing synthetic fixtures stay byte-identical and still load. | `src/market/events.ts`, `src/market/validation.ts` |
| S4 | **Recorded scenario**: a scenario whose fee and message-cost defaults come from the decision document, used by `replay --fixture <recorded.jsonl> --scenario recorded`. | `src/scenarios.ts`, `src/cli/main.ts` |
| S5 | **Tests** A1 to A11 below, all runnable offline in CI from generated raw captures (a test-side generator that emits the venue's message format with controllable gaps, duplicates, reordering and corruption). | `tests/capture-format.test.ts`, `tests/normalize.test.ts`, `tests/recorded-replay.test.ts` |
| S6 | **Real-session evidence** A12: one first-party capture, normalized and replayed twice, reported in the PR. Data committed only if the rights gate allows it; otherwise hashes and the normalize report only. | PR description |
| S7 | **Docs**: fill the "how to capture" and "how to normalize" commands into REPLAY.md; keep the contract documents as the source of truth (edit them only to correct an error, and say so in the PR). | `docs/REPLAY.md` |

## 2. Out of scope (do not add)

- Any order placement, account, wallet, API key, credential handling, or Jev integration.
- Any RL, RLVR, model-backed controller, or change to the controller contract.
- Any change to matching (`src/execution/paper.ts`), accounting (`src/portfolio/`), risk, or the ledger schema. The optimistic `front_of_queue` variant named in M2_EVALUATION_PROTOCOL.md §2 is a later PR.
- Third-party recorded data (`third_party_receive`) adapters.
- A sensitivity-grid CLI: the grid is produced programmatically with `replay()` (REPLAY.md, "Programmatic use") in a later PR.
- Committing any recorded data whose redistribution rights are not `permitted` with `sample_permitted` in the `rights` block.

## 3. Acceptance tests

All tests use the existing style (vitest, behaviour through public interfaces). Generated raw captures use the real message format of the selected venue. "Byte-identical" means the serialized files compare equal with `cmp`.

| id | test | passes when |
|---|---|---|
| A1 | normalize determinism | the same raw files normalized twice yield byte-identical fixture files and normalize reports; a one-byte change to a raw file changes the raw hash in the header and fails the manifest check |
| A2 | replay determinism on recorded input | a normalized fixture replayed twice yields byte-identical ledgers for all three run kinds and identical `results.json` (output paths aside) |
| A3 | observation-time causality | (a) for every `policy_decision`, the book it cites has `obsTime <= simTime`; (b) for every `fill`, `observedAt >= sourceMarketTime` and `observedAt >= establishedBy` print's `obsTime`; (c) the existing "future cannot change the past" prefix test passes on a normalized fixture: truncating the raw capture leaves the earlier ledger prefix unchanged |
| A4 | three-run comparison | `no_trade`, `unsteered`, `steered` replay the same recorded fixture (same content hash in all three `replay_started`), `no_trade` has zero fills, and `results.json` contains the comparison block |
| A5 | ledger reconciliation | `Ledger.verify` passes and cash, inventory, fees, message costs and gross realized P&L rebuilt from `fill` and `tx_cost` entries equal the summary exactly, for all three runs |
| A6 | assumptions exposed | `results.json` and the console output show `fillUncertainty`, `fills.uncertain`, `fills.lateAfterCancel`, `portfolio.feesPaid`, `portfolio.txCostsPaid`, `config.execution.orderLatencyMs`, `config.execution.cancelLatencyMs`, `config.maxStalenessMs`, and the header's `capture.lagStatsMs`, `capture.clockSync`, `rights` |
| A7 | gaps | a raw capture with a broken sequence rule yields a segment cut at the last applied update (no book event from stale state, no trade after the gap attached), a second segment after the resync, and both cuts listed in the report; a disconnect without resync ends the segment with `gap_disconnect` |
| A8 | reordering | (a) a trade received after a later-venue-time depth update stays in arrival order with non-decreasing `obsTime` and the engine's venue-order matching handles it (fill totals identical to the in-order permutation, per the M1 Case B tests); (b) a raw capture with a backwards wall-clock step is cut at that record (R3); (c) a fixture hand-edited to violate `obsTime` ordering is rejected by the engine as `out_of_order` with the earlier ledger prefix unchanged |
| A9 | malformed source events | an undecodable frame, an off-tick price, a non-positive trade size, a duplicate trade id and a duplicate depth update are each counted and dropped by reason; a malformed depth update cuts the segment; a snapshot that never applies to the stream refuses the segment (R6) |
| A10 | rights gate | the normalizer refuses to write a fixture without a valid `rights` block (R8); a repository test enumerates `fixtures/*.jsonl` and fails on any `synthetic: false` fixture whose `rights` is not `permitted` + `sample_permitted` with a terms URL and date |
| A11 | receive-clock rules | a raw file whose records lack `recvWallNs`/`recvMonoNs` is refused (R1); a segment with more than 0.1% negative lag is refused (R2); `obsTime` in an emitted fixture equals `floor(recvWallNs / 1e6)` of the raw record it cites for every event |
| A12 | real session (manual, reported) | one first-party capture of at least 60 minutes on the selected venue from an NTP-disciplined host: normalize twice (A1), replay twice (A2), report raw file hashes, fixture content hash, segment start/end reasons, lag statistics, drop counts, the three-run table, `fills.uncertain` and `queueConsumedWithoutFill`; data committed only if A10 allows |

## 4. Definition of done

- `npm run typecheck`, `npm test`, `npm run demo` pass; the two shipped synthetic fixtures are byte-identical to before (A1 of Milestone 1 still holds).
- A1 to A11 are in CI; A12's evidence is in the PR description.
- The PR touches nothing under `src/execution`, `src/portfolio`, `src/risk`, `src/controller`, `src/ledger`.
- The PR is a draft and is not merged by the implementer.

## 5. Paste-ready prompt for Grok

```
You are implementing Milestone 2 of https://github.com/Bthornton1994/Markout-Ledger: replaying RECORDED market observations through the existing deterministic two-clock replay engine. Milestone 1 (merged to main) proves deterministic replay and a causal decision ledger on synthetic data. Your job is the smallest implementation PR defined in docs/M2_GROK_HANDOFF.md, implementing docs/M2_DATA_CONTRACT.md for the venue and instrument selected in docs/M2_DATA_SOURCE_DECISION.md: Bybit spot BTCUSDT over the public WebSocket (adapter bybit-spot-v5, contract section 8). The Binance alternate adapter (contract section 8.6) is NOT part of this PR. Read those three documents, docs/M2_EVALUATION_PROTOCOL.md, docs/EVENT_SCHEMA.md, docs/EXECUTION_MODEL.md and docs/REPLAY.md before writing code, and inspect src/market/events.ts, src/market/validation.ts, src/engine/replay.ts (observation intake) and tests/helpers.ts.

Branch and PR: start from main, work on a branch named grok/m2-recorded-replay, open a DRAFT pull request, keep it a draft, do not merge.

Build exactly this (handoff section 1):
1. src/capture/: a market-data-only capture tool for the selected venue. Public WebSocket + public REST snapshot only, using Node 22's built-in WebSocket and fetch (no new runtime dependency, no API keys, no account, no order code anywhere in the package). It writes raw capture format v1 (contract section 4; schemas/capture-record.v1.schema.json): every received frame verbatim, in arrival order, with recvWallNs and recvMonoNs taken at receipt before parsing; lifecycle records (ws_open/ws_close/ws_error/subscribe/snapshot_request/snapshot/note); hourly rotation with per-file SHA-256; manifest_start with the clock-sync report (chronyc tracking or equivalent, verbatim) and the instrument specification fetched verbatim; manifest_end with counts and file hashes.
2. src/normalize/: raw capture v1 -> fixture schema v2 (contract sections 5 and 6; schemas/fixture.v2.schema.json). Adapter decode for the venue's depth, trade and snapshot messages (field mapping in contract section 8); book synchronization exactly as the venue documents; full local book; one book event per applied update with the top `depth` levels (default 20); trades with aggressor side from the venue's maker/taker field; duplicates dropped and counted; a gap or disconnect ends the segment at the last applied update and a resync starts a new segment (never stitched); wall-clock steps cut the segment; per-segment lag statistics; the negative-lag floor; rejection rules R1 to R8; a normalize report sidecar. obsTime = floor(recvWallNs / 1e6) of the raw record, never anything derived from a venue timestamp.
3. Schema v2 in src/market/events.ts and validation.ts: FIXTURE_SCHEMA_VERSION 2, loader accepts 1 and 2, header rules of contract section 6.4, optional event fields venueSeq/rawRef/recvWallNs. The committed synthetic fixtures must stay byte-identical and keep loading.
4. A "recorded" scenario (fees and message costs from the decision document) and CLI commands: capture, normalize, and replay --fixture <path> --scenario recorded.
5. Tests A1 to A11 from handoff section 3, offline, from a test-side generator of the venue's real message format with controllable gaps, duplicates, reordering and corruption.
6. Real-session evidence A12: one capture of at least 60 minutes from an NTP-disciplined host, normalized twice and replayed twice; put raw hashes, fixture content hash, segment reasons, lag stats, drop counts, the three-run table and the fill-uncertainty counters in the PR description. Commit recorded data ONLY if the rights block is redistribution=permitted and publication=sample_permitted with the terms URL and the date a person checked them; otherwise commit nothing but hashes.

Do NOT: place orders or write any order-placement code; handle credentials; integrate Jev; add RL/RLVR; change src/execution, src/portfolio, src/risk, src/controller or src/ledger; add third-party recorded-data adapters; add a sensitivity-grid CLI; commit data whose redistribution rights are unclear; manufacture obsTime from venue time; describe venue-time-only archives as replay data.

Definition of done (handoff section 4): typecheck, tests and demo pass; A1 to A11 in CI; A12 evidence in the PR; the diff touches none of the excluded directories; the PR stays a draft. Report: branch, commit SHA, the test list with pass/fail, the A12 tables, and every place where you found the contract ambiguous or wrong (do not silently work around it; say what you assumed).
```
