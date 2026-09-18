# Milestone 2 data contract: from raw capture to replay fixture (v2)

Status: contract for implementation (see [M2_GROK_HANDOFF.md](M2_GROK_HANDOFF.md)). Venue and instrument: [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). Evaluation rules: [M2_EVALUATION_PROTOCOL.md](M2_EVALUATION_PROTOCOL.md). Machine-readable: `schemas/capture-record.v1.schema.json`, `schemas/fixture.v2.schema.json`.

The engine (Milestone 1) replays a JSONL fixture in which every observation carries `obsTime` (when the strategy could first know it) and `marketTime` (when it happened at the venue), consumes it lazily in file order, and rejects what it cannot trust (EVENT_SCHEMA.md). This contract says how such a fixture is produced from recorded market data so that those semantics remain true, and it **fails closed**: whenever a rule cannot be verified, no replay fixture is produced.

Two artifacts, one direction:

```
venue feed --(capture, first party)--> raw capture v1 (immutable) --(normalize)--> replay fixture v2 --(replay)--> ledger
```

## 1. `obsTime`: definition and prohibitions

`obsTime` is the **local wall-clock time, in integer milliseconds since the Unix epoch, at which the capture process finished receiving the raw message that carries the observation**, taken by the capture process from the operating system's realtime clock at receipt and before any parsing. When an observation can only be known once several raw records have arrived (a snapshot plus buffered updates, §5.3), `obsTime` is the receive time of the **latest** record needed to know it.

Rules:

1. `obsTime` is never derived from any venue field: not the event time, not the transaction or trade time, not a block timestamp, not a sequence number, and not "venue time plus a typical latency".
2. Data without a receive timestamp recorded by an identified capture process (venue historical archives, exchange CSV dumps, database extracts) is **venue-time-only data**. It is never labelled `synthetic: false` with a replay time basis. The normalizer cannot prove that a receive clock is genuine; what it can do is refuse anything that does not come from a raw capture v1 file written by an identified capture tool (R1) and apply the plausibility checks of R1b. Converting an archive into raw capture v1 by inventing receive clocks is a violation of this contract, not a workaround.
3. The capture process records two clocks per record: `recvWallMs`, the realtime clock in integer milliseconds (`Date.now()` in Node, read independently of any monotonic source), and `recvMonoNs`, the monotonic clock in nanoseconds (`process.hrtime.bigint()`). `recvWallMs` becomes `obsTime`. Deriving the wall clock from the monotonic one (start time plus elapsed) is forbidden: the two must be able to disagree, because their disagreement is how clock steps are detected (§5.6).
4. The capture host runs a disciplined clock (NTP or PTP, e.g. `chronyd`). The manifest records the synchronization report at start and end (§4.2). `clockSync` is `synchronized` only if both reports show a synchronized state with `|offsetMs| <= 5`; otherwise `unknown`, and the evaluation protocol classifies the session's results as inconclusive (I6). The capture also probes the venue clock (§8.1) and the normalizer records the estimated host-to-venue offset (§5.6); a host clock that runs behind the venue makes orders look live earlier than they were, so the bound is enforced, not just reported.
5. Third-party receive timestamps (a data vendor's own capture time) are a distinct time basis, `third_party_receive`. They are not "actual local receive time" and their latency distribution is not ours. The M2 build does **not** implement this basis: `validateHeader` rejects it with "time basis not implemented". When a later milestone adds it, the header must name the vendor, the capture location and the licence (schema: `provenance.capture.vendor` becomes required), the CLI banner and results must print the basis, and the evaluation protocol must report it separately.

`marketTime` is the venue's own timestamp for the event, in integer milliseconds, from the field the adapter names (§8). If the venue's resolution is coarser than a millisecond, the header states it and `maxStalenessMs` is chosen above it.

## 2. Capture path (first party, market data only)

No legitimately usable recorded session with receive timestamps exists for the selected venue (M2_DATA_SOURCE_DECISION.md §2, §3), so the session is produced by our own capture:

- A capture process connects to the venue's **public** market-data endpoints only. No API key, wallet, account or order path exists in the capture code; the package must not contain order-placement code at all. This is a review criterion.
- It subscribes to the book stream and the trade stream of exactly one instrument, obtains the book snapshot the venue's procedure requires (in-band for the selected stream, §8.2), and appends every received message **verbatim** to the raw capture with both receive clocks, in arrival order. It never reorders, dedups, parses-and-drops, or rewrites.
- It records its own lifecycle (connect, disconnect, reconnect, subscribe, snapshot request and response, clock probes, errors) as records in the same stream with receive clocks, so a normalizer can prove what was known when.
- It performs the same live sequence check as the normalizer (§8.2) and resubscribes when it detects a break, so that a fresh snapshot follows every gap; without that, the remainder of a capture after a gap would be unusable.
- It runs for a target duration (default 90 minutes) and rotates raw files at most hourly; every file is closed with its SHA-256.

A **usable session** is a capture segment that the normalizer accepts under §5 end to end: synchronized book, no gap, no clock cut, non-negative lag floor, bounded venue clock offset, at least 60 minutes (evaluation) or 10 controller windows (acceptance tests), with the sync report present. The first usable session is the acceptance input for the M2 build.

## 3. Immutability and provenance chain

| artifact | identity | hash |
|---|---|---|
| raw capture file | `captureId` (UUID v4 chosen at start) + `fileIndex` | SHA-256 over every byte of the file that precedes its `file_end` record, written into `file_end.sha256` and repeated in `manifest_end.files` |
| capture manifest | `captureId` | `manifest_start` is the first record of file 0; `manifest_end` is the last record of the last file, **after** that file's `file_end`, and is excluded from every hash |
| replay fixture | `provenance.capture.captureId` + `segmentIndex` | `fixtureContentHash` (existing canonical hash over header and events) |
| ledger | `replay_started.fixture.contentHash` and `replay_started.fixture.provenance` (which, in v2, carries `capture`, `instrumentSpec` and `rights`, §6.1) | existing hash chain |

Raw files are never modified after close. The normalizer recomputes every file hash before doing anything else (R1b). A normalizer re-run must reproduce a byte-identical fixture from the same raw files and the same normalizer version (acceptance test A1); the fixture header records the capturer, normalizer and adapter identities with their commits.

Trust model, stated plainly: the contract makes receive times *auditable* (immutable raw files, identified capture tool and host, clock reports, plausibility checks), not *provable*. The `capturer.commit` names the code that wrote the clocks; anyone re-running that code on their own host can compare lag distributions.

## 4. Raw capture format v1

One JSONL file per rotation, records in arrival order. Record index = 0-based line number within its file, counting every record type. Every record has `type`, `recvWallMs` (integer), `recvMonoNs` (string, integer nanoseconds). Payloads are the exact text received (`payload` is a string; binary frames are base64 with `encoding: "base64"`).

### 4.1 Records

| `type` | additional fields | meaning |
|---|---|---|
| `manifest_start` | `captureFormatVersion: 1`, `captureId`, `venue`, `instrument` (venue-native symbol), `streams` (subscription strings), `endpoints` (`ws`, `rest`), `capturer` (`name`, `version`, `commit`), `host` (`os`, `runtime`; no hostnames or addresses), `clock` (§4.2), `instrumentSpec` (`source`, `fetchedAtIso`, `payload` verbatim), `startedAtIso` | first record of file 0 |
| `file_start` | `fileIndex`, `previousFileSha256` | first record of every file after file 0 |
| `ws_open` / `ws_close` / `ws_error` | `detail` | connection lifecycle; a `ws_close` followed by `ws_open` is a reconnection |
| `subscribe` / `unsubscribe` | `request` (verbatim text sent) | written at send time; the venue's acknowledgement arrives as an ordinary `message` record |
| `snapshot_request` | `url` | REST request issued (clocks are the send time) |
| `snapshot` | `url`, `httpStatus`, `payload` | REST response body verbatim (clocks are the receive time of the full body) |
| `message` | `stream` (venue stream/topic if the frame carries one), `payload` | one received frame |
| `probe` | `url`, `sentWallMs`, `sentMonoNs`, `payload` | venue clock probe: request send clocks plus the verbatim response; the record's own clocks are the response receive time |
| `note` | `detail` | operator or tool note (clock step detected, resubscribe issued, budget exhausted) |
| `file_end` | `fileIndex`, `records`, `sha256` | last hashed record of a file: `sha256` covers all bytes before this record; `records` counts records before it |
| `manifest_end` | `endedAtIso`, `clock` (§4.2), `counts` (records by type), `files` (`fileIndex`, `sha256`, `records`) | follows the last file's `file_end`; excluded from every hash |

### 4.2 `clock` block

```json
{"source": "chrony", "report": "<verbatim `chronyc tracking` output>", "offsetMs": -0.31, "stratum": 2, "synchronized": true, "takenAtIso": "..."}
```

`source` is `chrony`, `ntpd`, `ptp`, `platform` (cloud-provided sync with its own report) or `unknown`. `synchronized` is false when the tool reports an unsynchronized state or no report could be taken.

## 5. Normalization contract

The normalizer is a pure function of (raw files, adapter version, options). It emits zero or more **segments**; each segment becomes one fixture file. It never emits a fixture for a segment it could not fully verify.

### 5.1 Adapter interface

A venue adapter decodes verbatim payloads into typed messages and nothing else:

```
decode(record) -> { kind: 'depth', firstSeq, lastSeq, venueTime, bids: [[price,size]...], asks: [[price,size]...] }
              |  { kind: 'snapshot', lastSeq, venueTime, bids, asks }
              |  { kind: 'trades', items: [{ tradeId, price, size, venueTime, aggressor: 'buy'|'sell'|'unknown', offBook: boolean }] }
              |  { kind: 'ignore', reason }            (acks, pongs, heartbeats, other streams)
              |  { kind: 'malformed', reason }
```

Prices and sizes are decimal strings exactly as received. `venueTime` is integer ms. The adapter also declares the instrument specification from the manifest's verbatim instrument payload: `tickSize`, `lotSize`, `priceDecimals`, `qtyDecimals`, `aggressorSource` (`maker_flag` / `taker_side` / `none`), `tradeStreamGranularity` (`per_fill` / `aggregated`), `tradeIdOrdered` (boolean), `source`, `fetchedAtIso`.

### 5.2 Ordering and identity

- Fixture order is raw arrival order; within one raw record that carries several items (a trade frame), array order. `seq` is assigned 1, 2, 3... in emission order within a segment.
- `eventId = ${captureId}:${fileIndex}:${recordIndex}:${elementIndex}` (`elementIndex` 0 for records that carry one observation, the array index for multi-item frames). `rawRef = {fileIndex, record, element}`. Every eventId in a segment is unique by construction, so the engine's `duplicate_event` rule cannot fire on a correctly normalized fixture (acceptance A9/A11 assert this).
- `event.symbol` and `header.symbol` are the venue-native symbol (`header.venueSymbol` repeats it); `event.venue` and `header.venue` are the adapter's venue name (`bybit-spot`).
- `obsTime = recvWallMs` of the record that carried the observation (or of the latest record needed, §5.3). The normalizer **asserts** `obsTime` non-decreasing across the events it emits and refuses the segment if the assertion fails (fail closed; it cannot happen if §5.6 is implemented, and the assertion is the proof).

### 5.3 Book synchronization and reconstruction

The normalizer maintains a full local book per segment from one snapshot plus the venue's incremental updates, per the venue's documented procedure (adapter §8 instantiates it). Generic rules:

- **In-band snapshot streams** (the selected Bybit stream): the snapshot message is the book. Applying it emits the segment's first `book` event with the snapshot's `obsTime` and `marketTime`.
- **Buffer-then-REST-snapshot streams** (Bybit `orderbook.full`, Binance): updates received before the snapshot are buffered. When the snapshot arrives and the venue's overlap rule is satisfied, all buffered updates that apply are folded in and **one** `book` event is emitted at the snapshot's `obsTime` (the earliest instant the state was knowable) with `marketTime` of the last folded update and `rawRef` of the snapshot record; `venueSeq` states the folded range. Updates received after the snapshot emit normally. A buffered update is never emitted with its own receive time.
- Each following update must continue the sequence exactly as the venue documents (adapter §8.2). A level with size zero removes the level; otherwise it replaces the level's size. A size-zero for a level the local book does not hold is a no-op counted as `dropped.deleteOfUnknownLevel`.
- For a depth-limited stream the local book is truncated to the stream's depth (50 for `orderbook.50`) on each side after every applied update; the fixture emits the top `depth` levels (default 20). Levels beyond the stream's depth are unknown and never invented.
- Every applied update emits **one `book` event**, whether or not the top `depth` levels changed, so the policy's book age (`maxBookAgeMs`) reflects what the feed delivered. Its `obsTime` is the update's receive time and its `marketTime` the update's venue time.
- A crossed reconstructed book (best bid `>=` best ask) is a reconstruction failure (R6). The engine's own `crossed_book` rejection remains as a second line.
- Optional cross-check: when the capture holds a REST snapshot whose `u` equals the local `u`, the top `depth` levels must match; a mismatch is R6.

### 5.4 Trades and aggressor side

Each trade item emits one `trade` event with `marketTime` = the venue's trade time, `tradeId` = the venue's trade id as a string, `aggressor` per the adapter. If the venue gives no aggressor information the value is `unknown` and `instrumentSpec.aggressorSource` is `none`; the engine treats `unknown` prints as able to fill either side, which is the more pessimistic picture.

Items the adapter marks `offBook: true` (block trades, trades against hidden order types that never appear in the book) are **not emitted**: they did not consume visible-book liquidity and would let the engine award fills against a queue that never existed. They are counted (`dropped.tradeOffBook`).

Limitations recorded in the header: whether the trade stream is per-fill or aggregated (an aggregated stream can merge several fills of one taker order into one print; the M1 rule "a fill is never larger than the printed trade size" then bounds by the merged size), and which venue clock each stream carries (§5.6).

### 5.5 Price and quantity conversion

- Prices and sizes are parsed as exact decimals into the engine's 1e-6 fixed point (`parsePrice`/`parseQty`, which refuse any non-zero digit beyond the sixth decimal place). The normalizer enforces `priceDecimals <= 6` and `qtyDecimals <= 6` from `instrumentSpec` (R5) and refuses otherwise.
- A price that is not a multiple of `tickSize`, or a size that is not a multiple of `lotSize`, is malformed (R4): the item is not emitted and counted (`dropped.offTickPrice`, `dropped.offLotSize`); a non-positive trade size is `dropped.nonPositiveTradeSize`; an undecodable frame is `dropped.undecodable`. A malformed **depth** update cuts the segment (R6) because the book can no longer be trusted.
- Header and event decimals are written through `fmtPrice`/`fmtQty` (six places); `instrumentSpec.tickSize`/`lotSize` keep the venue's verbatim strings.

### 5.6 Clock basis, skew and steps

- Venue time and receive time are on different clocks. The lag `obsTime - marketTime` is network latency plus the venue's publication delay plus the host-to-venue clock offset. The normalizer computes, per segment and per stream (`book`, `trade`), `lagStatsMs = {count, min, p1, p50, p99, max}` and writes it into the header.
- **Venue clock offset.** From the capture's `probe` records (§8.1) the normalizer estimates `offset = venueTime - (sentWallMs + recvWallMs) / 2` per probe with uncertainty `±(recvWallMs - sentWallMs) / 2`, and records `venueClockOffsetMs = {samples, medianMs, medianRttMs, maxAbsMs}`. R2b refuses the segment if `|medianMs| > 50` or `medianRttMs > 500`. The sign matters: a host clock behind the venue makes our orders appear live earlier on the venue clock than they were (optimistic eligibility); the evaluation protocol treats `|medianMs| > 25` as inconclusive (I6).
- **Negative lag floor.** If more than 0.1% of a segment's events have `obsTime < marketTime`, the segment is refused (R2). The remaining few are left as they are and the engine rejects them (`invalid_timestamps`), which the ledger records. `obsTime` is never shifted.
- **Wall-clock steps.** For consecutive raw records (across file rotation; the normalizer carries the previous file's last clocks itself), let `Δwall = recvWallMs[i] - recvWallMs[i-1]` and `Δmono = (recvMonoNs[i] - recvMonoNs[i-1]) / 1e6`. Any `Δwall < 0`, or `|Δwall - Δmono| > 10` ms, is a clock cut (R3) at record `i`: the segment ends at record `i-1`, and record `i` is the first record of the next segment (`startReason: resync_after_clock_cut`), which continues with the sequence-verified local book (no fresh snapshot is needed because the venue sequence is intact). `recvMonoNs` must be strictly increasing; a non-increase is R1b.
- Different venue streams may carry different venue clocks; the adapter states which field it uses per stream and the header records both names.

### 5.7 Duplicates

- Depth updates whose sequence equals the applied sequence are dropped and counted (`dropped.depthDuplicate`). A sequence that goes backwards is not a duplicate: it is a reset or regression and handled by the adapter's sync rule (§8.2) as a cut.
- Trades whose `tradeId` was already emitted in the segment are dropped and counted (`dropped.tradeDuplicate`), keyed per adapter (§8.3).
- Only when `instrumentSpec.tradeIdOrdered` is true is a trade id that goes backwards counted as `dropped.tradeIdRegression` and not emitted. For venues with opaque ids (Bybit UUIDs) the rule is disabled.

### 5.8 Gaps, cuts, segments and reconnection

- A gap is any break in the venue's sequence rule (§8.2), any `ws_close`/`ws_error` before the next `ws_open`, or a venue-documented "resync required" signal. The segment then **ends at the raw record immediately before the record that revealed the gap**: every event carried by earlier records is emitted (trades between the last applied update and the gap-revealing record included; they are matched against the last verified book, as any inter-update trade is), and `capture.endRawRecord` is that index. No book event is emitted from stale state and nothing after the gap is attached.
- After a reconnection or resubscription the capture obtains a fresh snapshot; the normalizer starts a **new segment** at that snapshot (new fixture file, `segmentIndex + 1`). Segments are never stitched.
- Segment reasons. `endReason` is one of `capture_end`, `gap_sequence` (sequence break, reset signal or `seq` regression), `gap_disconnect`, `clock_cut`, `reconstruction_failure` (snapshot never followed by a continuing update, crossed book, cross-check mismatch), `malformed_depth`. `startReason` of the next segment is `capture_start` for the first segment, `resync_after_clock_cut` after `clock_cut`, and `resync_after_gap` after every other reason. Every cut is listed in `capture.cuts` with `{reason, fileIndex, record, detail}`.
- Trades observed while no verified book exists (before the first snapshot of a segment, or after a cut until the next snapshot) are not emitted; they are counted (`dropped.tradeWhileUnsynced`).

### 5.9 Rejection and fail-closed rules

| rule | condition | effect |
|---|---|---|
| R1 | raw manifest missing, `captureFormatVersion` unsupported, records lacking `recvWallMs`/`recvMonoNs`, or `capturer` identity absent | no fixture; error names the missing field |
| R1b | recomputed file SHA-256 differs from `file_end.sha256` or from `manifest_end.files`; `recvMonoNs` not strictly increasing; any `recvWallMs` outside `[manifest_start.startedAtIso - 60 s, manifest_end.endedAtIso + 60 s]` | no fixture; error names the file and record |
| R2 | negative lag floor breached (§5.6) | segment refused; diagnostics written |
| R2b | venue clock offset or probe round-trip beyond the bound (§5.6) | segment refused |
| R3 | wall-clock step (§5.6) | segment cut at the record |
| R4 | undecodable frame, off-tick price, off-lot size, non-positive trade size | item not emitted, counted by key; a malformed depth update triggers R6 |
| R5 | instrument decimals exceed six, or the manifest's instrument spec is missing | no fixture |
| R6 | book cannot be reconstructed: no continuing update after a snapshot, sequence rule broken, reset or regression, crossed reconstructed book, cross-check mismatch, malformed depth update | segment cut at the last verified book, or refused if none was verified |
| R7 | segment shorter than `--min-windows` windows of `--window-ms` (defaults 10 and 3000) | fixture not written; reported as too short |
| R8 | `rights` block absent or invalid (§6.3) | no fixture |

Every dropped or cut item is counted in the header (`capture.dropped`, `capture.cuts`) and listed with raw record indices in the sidecar `*.normalize-report.json`, so nothing disappears silently.

## 6. Fixture schema v2 (versioned changes to the JSONL schema)

Supported schema versions become `[1, 2]`: version 1 is the existing synthetic format, which the synthetic generator and the test helpers keep writing unchanged (the committed fixtures stay byte-identical); version 2 is required for `synthetic: false`. The header type becomes `schemaVersion: 1 | 2`; the v2 rules below apply only when `schemaVersion === 2`, and the synthetic-label check stays first.

### 6.1 Header additions (v2)

| field | required when | content |
|---|---|---|
| `depth` | v2 | number of levels emitted per book event |
| `venueSymbol` | v2 | venue-native symbol (equals `symbol`) |
| `provenance.timeBasis.obsTime` | always | `"capture_receive"` for first-party captures; `"third_party_receive"` is reserved and rejected by this build; synthetic fixtures keep their descriptive string |
| `provenance.timeBasis.marketTime` | always | the venue field(s) used per stream and their resolution |
| `provenance.instrumentSpec` | `synthetic: false` | §5.1 fields |
| `provenance.capture` | `synthetic: false` | `captureId`, `captureFormatVersion`, `rawFiles: [{fileIndex, sha256, records}]`, `segmentIndex`, `startReason`, `endReason`, `endRawRecord: {fileIndex, record}`, `capturer` / `normalizer` (`name`, `version`, `commit`), `adapter` (`name`, `version`), `clockSync` (`synchronized` / `unknown`), `clockReports: {start, end}` (§4.2 blocks), `venueClockOffsetMs`, `lagStatsMs: {book, trade}`, `dropped` (counts by key), `cuts` (list) |
| `provenance.rights` | `synthetic: false` | §6.3 |
| `startTime`, `endTime` | always | `startTime` is the `obsTime` of the segment's first emitted event (no rounding; the engine aligns windows to it), `endTime` the `obsTime` of the last emitted event |
| `synthetic`, `syntheticLabel`, scales, `eventCount`, `tickSize`, `lotSize` | unchanged | unchanged semantics |

`capture`, `instrumentSpec` and `rights` live **under `provenance`** so that the existing `replay_started.fixture.provenance` (recorded as an opaque object) carries them into every ledger without a ledger schema change, and `results.json`'s `fixture.header` carries them too.

### 6.2 Event additions (v2, optional in the wire format)

| field | content |
|---|---|
| `venueSeq` | adapter-defined opaque string, format fixed per adapter in §8 |
| `rawRef` | `{fileIndex, record, element}`: the raw record and item that carried it |
| `recvMonoNs` | string: the monotonic receive clock, for sub-millisecond ordering audits |

`obsTime`, `marketTime`, `seq`, `eventId`, `symbol`, `venue`, `type`, and the book/trade payload keep their v1 meaning. The engine ignores the additions; `fixtureContentHash` covers them.

### 6.3 `rights` block and the publication gate

```json
{"termsUrl": "...", "termsCheckedOn": "YYYY-MM-DD", "checkedBy": "<person>", "redistribution": "permitted" | "prohibited" | "unclear", "publication": "hash_only" | "sample_permitted", "note": "..."}
```

The block is supplied to the normalizer as a file (`--rights <path>`); it is not part of the raw capture. A recorded fixture is committed to this public repository only when `publication` is `sample_permitted` **and** `redistribution` is `permitted`, with the terms URL and the date a person checked them. Everything else stays outside the repository; the repository carries the fixture's content hash, the raw files' hashes and the normalize report. A repository test enumerates `fixtures/*.jsonl` and fails on any `synthetic: false` fixture that violates this rule.

### 6.4 Validation additions

`validateHeader`: version 2 requires `depth`, `venueSymbol` and both `timeBasis` strings; `synthetic: false` requires version 2, `provenance.source === "recorded"`, `provenance.recordedFrom`, `provenance.captureMethod`, `provenance.capture`, `provenance.instrumentSpec`, `provenance.rights`, and `provenance.timeBasis.obsTime === "capture_receive"` (`third_party_receive` rejected as not implemented). Version 1 keeps today's rules. Everything the engine validates per event (EVENT_SCHEMA.md) is unchanged.

## 7. What the engine does with a v2 fixture

The replay path is unchanged. `replay_started` records `fixture.provenance` (now carrying capture identity, raw hashes, clock reports, lag statistics, drop counts, instrument specification and the rights block) and the fixture content hash. Two presentation changes are part of the build (handoff S4): the run summary's and `results.json`'s disclaimers branch on `header.synthetic` (recorded wording: paper execution on recorded observations, not evidence of profitability), and `results.json` gains a per-run `config` block copied from `replay_started.config` so fees, message costs, latencies and `maxStalenessMs` are readable without the ledger. The console header for a recorded fixture prints the staleness limit, `lagStatsMs`, `clockSync`, `venueClockOffsetMs` and the rights summary.

## 8. Venue adapter: Bybit spot BTCUSDT (`adapter.name = "bybit-spot-v5"`, `adapter.version = "1"`)

All field names below were read from the venue's official documentation repository `bybit-exchange/docs` at commit `75994fda16e0` on 2026-09-18 (M2_DATA_SOURCE_DECISION.md §5).

### 8.1 Endpoints and subscriptions

| purpose | endpoint / message |
|---|---|
| WebSocket | `wss://stream.bybit.com/v5/public/spot` |
| subscribe (one request) | `{"op":"subscribe","args":["orderbook.50.BTCUSDT","publicTrade.BTCUSDT"]}` written as a `subscribe` record; the acknowledgement (`"op":"subscribe","success":true`) arrives as a `message` record |
| heartbeat | `{"op":"ping"}` every 20 s (`note` records; pong replies are `message` records) |
| instrument spec (manifest) | `GET https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT` verbatim; `priceFilter.tickSize` becomes `tickSize`, `lotSizeFilter.basePrecision` becomes `lotSize`; decimals derived; `aggressorSource: "taker_side"`, `tradeStreamGranularity: "per_fill"` (one element per execution as delivered), `tradeIdOrdered: false` |
| optional cross-check snapshot | `GET /v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50` (`u`, `seq`, `cts`), taken every 10 minutes; used only for §5.3's cross-check, never to build the book |
| clock probe | `GET /v5/market/time` (`timeNano`) at start, every 10 minutes and at end, as `probe` records (§4.1, §5.6) |
| fallback book stream (later PR) | `orderbook.full.BTCUSDT` (delta-only, 200 ms) initialized from `GET /v5/market/full_orderbook` with the venue's documented `seq`/`u` procedure; **not part of the smallest PR** |

Connection budget: at most 5 reconnects per 5 minutes; beyond that the capture stops and records `ws_error` (the venue limits connections per IP). Every reconnect is a segment boundary. Live checks the capture performs: the `u` rule of §8.2 (on a break it records a `note`, sends `unsubscribe`, then `subscribe`, so a fresh in-band snapshot follows) and the clock-step rule of §5.6 (recorded as a `note`; no resubscribe needed).

### 8.2 Book messages

Decode dispatches on `topic` first: `orderbook.` frames are book messages, `publicTrade.` frames are trade messages (§8.3), frames without `topic` (subscription acks, pong) are `ignore`. The spot gateway puts `ts` before `type`; parse by key, never by position.

```json
{"topic":"orderbook.50.BTCUSDT","ts":1687940967466,"type":"snapshot","data":{"s":"BTCUSDT","b":[["30247.20","30.028"]],"a":[["30247.30","0.5"]],"u":177400506,"seq":7961638723},"cts":1687940967464}
{"topic":"orderbook.50.BTCUSDT","ts":1687940967486,"type":"delta","data":{"s":"BTCUSDT","b":[["30240.00","0"]],"a":[],"u":177400507,"seq":7961638724},"cts":1687940967484}
```

| adapter output | source |
|---|---|
| `kind` | `snapshot` when `type == "snapshot"`, else `depth` |
| `firstSeq`, `lastSeq` | both `data.u` |
| `venueTime` (fixture `marketTime`) | `cts` (matching-engine time); absent `cts` is malformed |
| `venueSeq` | `"u:<u>;seq:<seq>;ts:<ts>"` |
| `bids`, `asks` | `data.b`, `data.a` as decimal strings; size `"0"` deletes the level |

Synchronization (contract §5.3 instantiated):

1. Messages before the first `snapshot` after a subscribe are counted (`dropped.depthBeforeSnapshot`) and not applied.
2. A `snapshot` replaces the local book, sets `localU = data.u`, and emits the segment's first `book` event. A snapshot that arrives while a segment is open ends that segment (`endReason: "gap_sequence"`, detail `"snapshot_reset"`) and starts a new one.
3. A `delta` with `data.u == localU + 1` is applied and `localU` advances. `data.u == localU` is a duplicate (`dropped.depthDuplicate`). `data.u == 1`, `data.u < localU` (regression) or `data.u > localU + 1` (missed updates) end the segment at the last applied update (`gap_sequence`, detail `"reset"`, `"regression"` or `"jump"`); the next segment starts only at the next `snapshot`.
4. `seq` must not decrease across applied messages; a decrease ends the segment (`gap_sequence`, detail `"seq_regression"`).
5. After each applied message the local book is truncated to 50 levels per side; the fixture emits the top `depth` (default 20). A snapshot followed by no `delta` with `u == snapshot.u + 1` before the next snapshot, `ws_close` or end of capture is `reconstruction_failure`: a lone snapshot is not a verified book and the segment is refused.

The venue documents `u+1` contiguity for `orderbook.full` and only reset semantics for `orderbook.50`; the `u+1` rule above is this repository's fail-closed decision. The normalize report counts `sequenceJumps` for this stream and the acceptance session (handoff A12) reports the count; a non-zero count moves the fallback stream into scope and this section is amended.

### 8.3 Trade messages

```json
{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1672304486868,"data":[{"T":1672304486865,"s":"BTCUSDT","S":"Buy","v":"0.001","p":"16578.50","i":"20f43950-d8dd-5b31-9112-a178eb6023af","BT":false,"RPI":false,"seq":1783284617}]}
```

The frame's `type` is always `"snapshot"` and is ignored (dispatch is on `topic`). One `trade` event per array element, in array order (the venue sorts by match time). `marketTime = T`; `tradeId = i` (an opaque UUID, no ordering; `tradeIdOrdered: false`); `aggressor = "buy"` when `S == "Buy"`, `"sell"` when `S == "Sell"`; `price = p`, `size = v`; `venueSeq = "i:<i>;seq:<seq>"`. Elements with `BT == true` (block trade) or `RPI == true` (retail-price-improvement, never shown in the book) are `offBook` (§5.4). Duplicates are keyed on `(s, i)` per segment; `seq` is not a trade key (several frames can share one `seq`).

### 8.4 Clocks and lag

`marketTime` for books is `cts`, for trades `T`, both matching-engine milliseconds by the venue's description; `ts` (publication) is kept in `venueSeq`. Lag statistics are computed per stream against those fields; the venue clock offset from `GET /v5/market/time` probes (`timeNano` to ms) per §5.6.

### 8.5 Instrument and recorded scenario

From the documented instrument example (re-fetched verbatim at capture): `tickSize "0.1"`, `lotSize "0.000001"`, `priceDecimals 1`, `qtyDecimals 6`. The `recorded` scenario takes `tickSize` and `lotSize` from the fixture header (`parsePrice`/`parseQty`) into **all three** configuration sites (`execution`, `policy`, `risk`) at replay time, checks them against `provenance.instrumentSpec`, and uses BTC/USDT-scaled values:

| field | value |
|---|---|
| `policy.baseQuoteQty` | 0.001 BTC; `baseHalfSpreadBps 5`, `maxBookAgeMs 1000`, `requoteThresholdTicks 2` as today |
| `initialCash` | 10 000 USDT |
| `risk.maxPosition` / `maxOrderQty` / `maxLoss` | 0.005 BTC / 0.002 BTC / 20 USDT |
| `execution.makerFeeBps` | 10 (search-derived spot fee; swept by the sensitivity grid) |
| `execution.placementCost` / `cancelCost` | 0 |
| `execution.orderLatencyMs` / `cancelLatencyMs` | 50 / 50 |
| `policyTickMs` / `windowMs` / `controllerDeadlineMs` | 300 / 3000 / 200 |
| `maxStalenessMs` / `outcomeHorizonsMs` | 500 (revisit against `lagStatsMs`) / [1000, 3000] |

### 8.6 Appendix: alternate adapter, Binance spot BTCUSDT (`binance-spot-v3`, not in the smallest PR)

Read from `binance/binance-spot-api-docs` at `828ca74b809c`. Market-data-only hosts: `wss://data-stream.binance.vision:443/stream?streams=btcusdt@depth@100ms/btcusdt@trade` (combined-stream frames are `{"stream": ..., "data": ...}`) and `https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=5000`; `GET /api/v3/exchangeInfo?symbol=BTCUSDT` for `PRICE_FILTER.tickSize` and `LOT_SIZE.stepSize`. Depth: `U` first id, `u` last id, `E` event time (publication of the 100 ms batch; no matching time on spot depth), `b`/`a` levels. Trades: `t` id (`tradeIdOrdered: true`), `p`, `q`, `T`, `m` (buyer is maker: `aggressor = "sell"` when true, `"buy"` when false). Snapshot: `lastUpdateId`, no timestamp. Synchronization exactly as documented: buffer, snapshot, drop events with `u <= lastUpdateId`, first applied event must satisfy `U <= lastUpdateId + 1 <= u`, then `U == previous u + 1`; `U > local + 1` is a gap (restart); buffered events fold into one book event at the snapshot's receive time (§5.3). Timestamps are milliseconds by default; with `timeUnit=MICROSECOND` the raw stays in microseconds, the fixture floors to milliseconds and the header records the unit. Connections are closed by the venue after 24 hours, so every day has at least one segment boundary. Same publication and jurisdiction conditions as Bybit.

## 9. Versioning

- Raw capture format: `captureFormatVersion` (integer). Any change to record types or clock semantics increments it; old raw files remain readable by keeping the old decoder.
- Fixture schema: `schemaVersion` 1 (synthetic, existing) and 2 (this document). Additive optional fields do not bump the version; a change to the meaning of `obsTime`, `marketTime`, `seq` or the header requirements does.
- Adapter: `adapter.version` in the header; a change to any field mapping or synchronization rule bumps it, and re-normalization of existing raw files is expected to change fixture hashes (recorded in the normalize report).
- Ledger schema is unchanged (version 1).
