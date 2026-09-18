# Milestone 2 data contract: from raw capture to replay fixture (v2)

Status: contract for implementation (see [M2_GROK_HANDOFF.md](M2_GROK_HANDOFF.md)). Venue and instrument: [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). Evaluation rules: [M2_EVALUATION_PROTOCOL.md](M2_EVALUATION_PROTOCOL.md).

The engine (Milestone 1) replays a JSONL fixture in which every observation carries `obsTime` (when the strategy could first know it) and `marketTime` (when it happened at the venue), consumes it lazily in file order, and rejects what it cannot trust (EVENT_SCHEMA.md). This contract says how such a fixture is produced from recorded market data so that those semantics remain true, and it **fails closed**: whenever a rule cannot be verified, no replay fixture is produced.

Two artifacts, one direction:

```
venue feed --(capture, first party)--> raw capture v1 (immutable) --(normalize)--> replay fixture v2 --(replay)--> ledger
```

## 1. `obsTime`: definition and prohibitions

`obsTime` is the **local wall-clock time at which the capture process finished receiving the raw message that carries the observation**, truncated to integer milliseconds since the Unix epoch. It is taken by the capture process itself, from the operating-system clock of the capture host, at receipt and before any parsing.

Rules:

1. `obsTime` is never derived from any venue field: not the event time, not the transaction or trade time, not a block timestamp, not a sequence number, and not "venue time plus a typical latency".
2. Data without a receive timestamp recorded by an identified capture process (venue historical archives, exchange CSV dumps, snapshots taken from a database) is **venue-time-only data**. It can never be labelled `synthetic: false` with a replay time basis; the normalizer refuses it (§5.9, rule R1). It may be used for offline statistics, not for causal replay.
3. The capture process records two clocks per message: `recvWallNs` (`Date.now()`-class wall clock in nanoseconds, via `process.hrtime`-corrected wall time or the platform equivalent) and `recvMonoNs` (monotonic, `process.hrtime.bigint()`). Wall time becomes `obsTime`; the monotonic clock exists to detect wall-clock steps (§5.6).
4. The capture host must run a disciplined clock (NTP or PTP, e.g. `chronyd`). The capture manifest records the synchronization report at start and end (§4.2). A session without a sync report is still normalized but the fixture header carries `clockSync: "unknown"` and the evaluation protocol classifies its results as inconclusive (I6).
5. Third-party receive timestamps (a data vendor's own capture time) are a distinct time basis, `third_party_receive`. They are admissible only when the vendor documents them as receive times and the fixture header names the vendor, the capture location and the licence. They are not "actual local receive time" and their latency distribution is not ours; the smallest M2 build does not implement this basis.

`marketTime` is the venue's own timestamp for the event, in integer milliseconds, as carried in the message (the adapter, §8, names the exact field). If the venue's timestamp has coarser resolution than a millisecond, the header states the resolution and `maxStalenessMs` must be chosen above it.

## 2. Capture path (first party, market data only)

Because no legitimately usable recorded session with receive timestamps exists for the selected venue (M2_DATA_SOURCE_DECISION.md §3), the session is produced by our own capture:

- A capture process connects to the venue's **public** market-data endpoints only. No API key, no wallet, no account, no order path exists in the capture code. The capture binary must not link any order-placement code; this is a review criterion.
- It subscribes to the book stream and the trade stream of exactly one instrument, obtains the book snapshot the venue's synchronization procedure requires, and appends every received message **verbatim** to the raw capture with both receive clocks, in arrival order. It never reorders, dedups, parses-and-drops, or rewrites.
- It records its own lifecycle (connect, disconnect, reconnect, snapshot request and response, errors) as records in the same stream, each with receive clocks, so a normalizer can prove what was known when.
- It runs for a target duration (default 90 minutes) and rotates raw files at most hourly; every file is closed with its SHA-256.

A **usable session** is a capture segment that the normalizer accepts under §5 end to end: synchronized book, no gap, no clock cut, non-negative lag floor, at least 60 minutes (evaluation) or 10 controller windows (acceptance tests), with the sync report present. The first usable session is the acceptance input for the M2 build.

## 3. Immutability and provenance chain

| artifact | identity | hash |
|---|---|---|
| raw capture file | `captureId` (UUID v4 chosen at start) + file index | SHA-256 over the file bytes, written into the closing record of the file and into the manifest |
| capture manifest | `captureId` | part of the last raw file (`manifest_end`) |
| replay fixture | `fixture.header.capture.captureId` + `segmentIndex` | `fixtureContentHash` (existing canonical hash over header and events) |
| ledger | `replay_started.fixture.contentHash` and `replay_started.fixture.provenance.capture.rawFiles[*].sha256` | existing hash chain |

Raw files are never modified after close. A normalizer re-run must reproduce a byte-identical fixture from the same raw files and the same normalizer version (acceptance test A2 in the handoff); the fixture header records the normalizer version and the adapter version.

## 4. Raw capture format v1

One JSONL file per rotation, records in arrival order. Every record has `type`, `recvWallNs` (string, integer nanoseconds), `recvMonoNs` (string, integer nanoseconds). Payloads are the exact text received (`payload` is a string; binary frames are base64 with `encoding: "base64"`).

### 4.1 Records

| `type` | additional fields | meaning |
|---|---|---|
| `manifest_start` | `captureFormatVersion: 1`, `captureId`, `venue`, `instrument` (venue-native symbol), `streams` (subscription strings), `endpoints` (`ws`, `rest`), `capturer` (`name`, `version`, `commit`), `host` (`os`, `runtime`; no hostnames or addresses), `clock` (§4.2), `startedAtIso` | first record of the first file |
| `file_start` | `fileIndex`, `previousFileSha256` | first record of every file after the first |
| `ws_open` / `ws_close` / `ws_error` | `detail` | connection lifecycle; a `ws_close` followed by `ws_open` is a reconnection |
| `subscribe` | `request` (verbatim text sent), `ack` (verbatim text received, if any) | what was subscribed |
| `snapshot_request` | `url` | REST request issued (send time in the receive clocks) |
| `snapshot` | `url`, `httpStatus`, `payload` | REST response body verbatim |
| `message` | `stream` (venue stream name if the frame carries one), `payload` | one received frame |
| `note` | `detail` | operator note (e.g. "clock slew detected by chrony") |
| `file_end` | `fileIndex`, `records`, `sha256` | last record of a file: SHA-256 of all bytes before this record |
| `manifest_end` | `endedAtIso`, `clock` (§4.2), `counts` (records by type), `files` (index, sha256, records) | last record of the last file |

### 4.2 `clock` block

```json
{"source": "chrony", "report": "<verbatim `chronyc tracking` output>", "offsetMs": -0.31, "stratum": 2, "synchronized": true, "takenAtIso": "..."}
```

`source` is `chrony`, `ntpd`, `ptp`, `platform` (cloud-provided sync with its own report) or `unknown`. `synchronized` is false when the tool reports an unsynchronized state or the report could not be taken; the fixture inherits `clockSync: "unknown"` in that case.

## 5. Normalization contract

The normalizer is a pure function of (raw files, adapter version, options). It emits zero or more **segments**; each segment becomes one fixture file. It never emits a fixture for a segment it could not fully verify.

### 5.1 Adapter interface

A venue adapter decodes verbatim payloads into typed messages and nothing else:

```
decode(record) -> { kind: 'depth', firstSeq, lastSeq, prevLastSeq?, venueTime, bids: [[price,size]...], asks: [[price,size]...] }
              |  { kind: 'trade', tradeId, price, size, venueTime, aggressor: 'buy'|'sell'|'unknown' }
              |  { kind: 'snapshot', lastSeq, venueTime?, bids, asks }
              |  { kind: 'ignore', reason }            (heartbeats, subscription acks, other streams)
              |  { kind: 'malformed', reason }
```

Prices and sizes are decimal strings exactly as received. `venueTime` is integer ms. The adapter also supplies the instrument specification (tick size, lot size, price and quantity decimals) from the venue's public instrument endpoint, captured verbatim in the manifest at capture start.

### 5.2 Ordering

Fixture order is raw arrival order. `seq` is assigned 1, 2, 3... in emission order within a segment. `obsTime = floor(recvWallNs / 1e6)` of the raw record that carried the event. Because `recvMonoNs` must be strictly increasing and the wall clock is checked against it (§5.6), `obsTime` is non-decreasing by construction; a fixture that violates EVENT_SCHEMA.md ordering is a normalizer bug, and the acceptance tests include a deliberately corrupted raw file to prove the engine still rejects such events.

### 5.3 Book synchronization and reconstruction

The normalizer maintains a full local book per segment from one snapshot plus the venue's incremental updates, exactly per the venue's documented procedure (adapter §8 quotes it). Generic rules:

- Updates received before the snapshot are buffered (they are already in the raw file with their receive times); after the snapshot arrives, updates whose `lastSeq` is at or before the snapshot's `lastSeq` are dropped as already reflected; the first applied update must cover the snapshot boundary as the venue documents (for a first/last-id scheme: `firstSeq <= snapshot.lastSeq + 1 <= lastSeq`); each following update must continue the sequence exactly as the venue documents (`firstSeq == previous.lastSeq + 1`, or `prevLastSeq == previous.lastSeq`).
- A level with size zero removes the level; otherwise it replaces the level's size. Levels are kept sorted; the top `depth` levels (default 20, recorded in the header) are emitted.
- Every applied update emits **one `book` event**, whether or not the top `depth` levels changed, so the policy's book age (`maxBookAgeMs`) reflects what the feed delivered. Its `obsTime` is the update's receive time and its `marketTime` the update's venue time.
- A crossed reconstructed book (best bid `>=` best ask) is a reconstruction failure, not an observation: the segment is cut (§5.9, R6). The engine's own `crossed_book` rejection remains as a second line.

### 5.4 Trades and aggressor side

Each trade message emits one `trade` event with `marketTime` = the venue's trade time, `tradeId` = the venue's trade id as a string, `aggressor` from the venue's maker/taker flag as the adapter documents; if the venue gives no aggressor information the value is `unknown` and the header says so (`instrumentSpec.aggressorSource: "none"`). The engine treats `unknown` prints as able to fill either side, so a venue without aggressor data yields a more pessimistic fill picture.

Limitations recorded in the header: whether the trade stream is per-fill or aggregated (an aggregated stream can merge several fills of one taker order into one print; sizes are then upper bounds per print, and the M1 rule "a fill is never larger than the printed trade size" is conservative in the wrong direction only if several prints are merged across our price level, which the adapter must state), and whether trades and depth updates share a clock (§5.6).

### 5.5 Price and quantity conversion

- Prices and sizes are parsed as exact decimals into the engine's 1e-6 fixed point (`parsePrice`/`parseQty`), which refuse more than six decimal places. The instrument must therefore have `priceDecimals <= 6` and `qtyDecimals <= 6`; the normalizer refuses otherwise (R5). The header carries `instrumentSpec` (`tickSize`, `lotSize`, `priceDecimals`, `qtyDecimals`, `source`, `fetchedAtIso`).
- A price that is not a multiple of `tickSize`, or a size that is not a multiple of `lotSize`, is a malformed message (R4): the event is not emitted and the count goes into the header; a malformed **depth** update cuts the segment because the book can no longer be trusted (R6).

### 5.6 Clock basis and skew

- Venue time and receive time are on different clocks. The lag `obsTime - marketTime` is network latency plus the venue's own publication delay plus the clock offset between the capture host and the venue. The normalizer computes the lag distribution per segment and stream (`min`, `p1`, `p50`, `p99`, `max`) and writes it into the header (`capture.lagStatsMs`).
- **Negative lag floor.** If more than 0.1% of a segment's events have `obsTime < marketTime`, the capture host clock or the venue clock is off by more than the tolerance and the segment is refused (R2). The remaining few are left as they are and the engine rejects them (`invalid_timestamps`), which the ledger records. `obsTime` is never shifted to "fix" this.
- **Wall-clock steps.** For consecutive raw records, `Δwall - Δmono` beyond 5 ms in either direction means the wall clock stepped or slewed abnormally; the segment is cut at that record (R3). Rotation boundaries carry the last clocks of the previous file so the check spans files.
- Different venue streams may carry different venue clocks (e.g. a trade time set at match, a depth event time set at publication). The adapter states which field it uses for each stream; the header records both fields' names.

### 5.7 Duplicates

- Depth updates whose `lastSeq` does not advance the applied sequence are dropped and counted (`dropped.depthDuplicate`).
- Trades whose `tradeId` was already emitted in the segment are dropped and counted (`dropped.tradeDuplicate`). Trade ids are tracked per segment; a trade id that goes backwards (venue ids are monotone where documented) is counted as `tradeIdRegression` and reported, not emitted.
- `eventId` in the fixture is `${captureId}:${fileIndex}:${recordIndex}` (the raw record that carried it), so the engine's `duplicate_event` rule can never fire on a correctly normalized fixture and the raw origin of every event is recoverable.

### 5.8 Gaps and reconnection

- A gap is any break in the venue's sequence rule (§5.3), any `ws_close`/`ws_error` before the next `ws_open`, or a venue-documented "resync required" signal. On a gap the current segment **ends at the last applied update**: no book event after it is emitted from stale state, and no trade received after the gap is attached to the segment.
- After a reconnection the capture re-runs the snapshot procedure; the normalizer starts a **new segment** (new fixture file, `segmentIndex + 1`, `startReason: "resync_after_gap"`). Segments are never stitched. The header records `endReason` (`capture_end`, `gap_sequence`, `gap_disconnect`, `clock_cut`, `reconstruction_failure`, `malformed_depth`) and the raw record index where it happened.
- Trades observed while the book is unsynchronized (before the first valid snapshot application) are not emitted; they are counted (`dropped.tradeWhileUnsynced`).

### 5.9 Rejection and fail-closed rules

| rule | condition | effect |
|---|---|---|
| R1 | raw manifest missing, `captureFormatVersion` unsupported, or the source has no per-record receive clocks | no fixture; error names the missing field |
| R2 | negative lag floor breached (§5.6) | segment refused; diagnostics written |
| R3 | wall-clock step (§5.6) | segment cut at the record |
| R4 | message the adapter cannot decode, off-tick price, off-lot size, non-positive size on a trade | event not emitted; counted by reason; a malformed depth update triggers R6 |
| R5 | instrument decimals exceed six, or the manifest's instrument spec is missing | no fixture |
| R6 | book cannot be reconstructed: snapshot never applies to the stream, sequence rule broken, crossed reconstructed book, malformed depth update | segment cut at the last verified book (or refused if no book was ever verified) |
| R7 | segment shorter than the minimum requested (`--min-windows`, default 10 windows of `windowMs`) | fixture not written; reported as too short |
| R8 | `rights` block (§6.3) absent or `publication` not one of the allowed values | no fixture |

Every dropped or cut item is counted in the header (`capture.dropped`, `capture.cuts`) and listed in a sidecar `*.normalize-report.json` with raw record indices, so nothing disappears silently.

## 6. Fixture schema v2 (versioned changes to the JSONL schema)

`FIXTURE_SCHEMA_VERSION` becomes 2. The loader accepts version 1 (existing synthetic fixtures, unchanged bytes) and version 2. A `synthetic: false` fixture is only valid at version 2.

### 6.1 Header additions (v2)

| field | required when | content |
|---|---|---|
| `depth` | always | number of levels emitted per book event |
| `venueSymbol` | always | venue-native symbol (`symbol` stays the engine-facing name) |
| `instrumentSpec` | `synthetic: false` | `tickSize`, `lotSize`, `priceDecimals`, `qtyDecimals`, `aggressorSource` (`maker_flag` / `taker_side` / `none`), `tradeStreamGranularity` (`per_fill` / `aggregated`), `source` (endpoint), `fetchedAtIso` |
| `provenance.timeBasis.obsTime` | always | `"capture_receive"` for first-party captures, `"third_party_receive"` (vendor named in `capture`), or the existing descriptive string for synthetic fixtures |
| `provenance.timeBasis.marketTime` | always | the venue field(s) used and their resolution |
| `capture` | `synthetic: false` | `captureId`, `captureFormatVersion`, `rawFiles: [{fileIndex, sha256, records}]`, `segmentIndex`, `startReason`, `endReason`, `endRawRecord`, `capturer` (`name`, `version`, `commit`), `normalizer` (`name`, `version`, `commit`), `adapter` (`name`, `version`), `clockSync` (`synchronized` / `unknown`), `clockReports` (start, end), `lagStatsMs` (per stream), `dropped` (counts by reason), `cuts` (list) |
| `rights` | `synthetic: false` | §6.3 |
| `synthetic`, `syntheticLabel`, scales, `startTime`, `endTime`, `eventCount` | unchanged | unchanged semantics; `startTime` is the receive time of the first emitted event rounded **up** to a whole second, `endTime` the receive time of the last emitted event |

### 6.2 Event additions (v2, optional in the wire format)

| field | content |
|---|---|
| `venueSeq` | string: the venue sequence covering this event (`"U-u"` for a depth update, the trade id for a trade) |
| `rawRef` | `{fileIndex, record}`: the raw record that carried it |
| `recvWallNs` | string: the nanosecond receive clock, for sub-millisecond ordering audits |

`obsTime`, `marketTime`, `seq`, `eventId`, `symbol`, `venue`, `type`, and the book/trade payload keep their v1 meaning. The engine ignores the additions; `fixtureContentHash` covers them.

### 6.3 `rights` block and the publication gate

```json
{"termsUrl": "...", "termsCheckedOn": "YYYY-MM-DD", "checkedBy": "<person>", "redistribution": "permitted" | "prohibited" | "unclear", "publication": "hash_only" | "sample_permitted", "note": "..."}
```

- A recorded fixture is committed to this public repository only when `publication` is `sample_permitted` **and** `redistribution` is `permitted`, with the terms URL and the date a person checked them. Everything else stays outside the repository; the repository carries the fixture's content hash, the raw files' hashes and the normalize report instead.
- A test in the M2 build enumerates `fixtures/*.jsonl` and fails if any `synthetic: false` fixture violates this rule, so the gate cannot be forgotten.

### 6.4 Validation additions

`validateHeader` gains the v2 rules: version 2 requires `depth`, `venueSymbol` and both `timeBasis` strings; `synthetic: false` requires version 2, `capture`, `instrumentSpec`, `rights`, `provenance.source === "recorded"`, `provenance.recordedFrom` and `provenance.captureMethod`, and `provenance.timeBasis.obsTime` in {`capture_receive`, `third_party_receive`}. Everything the engine already validates per event (EVENT_SCHEMA.md) is unchanged.

## 7. What the engine does with a v2 fixture

Nothing new on the replay path: `replay_started` already records the header's provenance and the fixture content hash, so with v2 it records the capture identity, raw hashes, clock reports, lag statistics, drop counts and the rights block. The CLI banner for a recorded fixture ("Recorded data fixture. Paper execution model only ...") already exists. Fees and message costs come from the scenario configuration and are printed in the console header and stored in `replay_started.config`; the recorded scenario sets them from the venue's published schedule (M2_DATA_SOURCE_DECISION.md §2) and the sensitivity grid varies them (M2_EVALUATION_PROTOCOL.md §2).

## 8. Venue adapter: Bybit spot BTCUSDT (`adapter.name = "bybit-spot-v5"`, `adapter.version = "1"`)

All field names below were read from the venue's official documentation repository `bybit-exchange/docs` at commit `75994fda16e0` on 2026-09-18 (M2_DATA_SOURCE_DECISION.md §5).

### 8.1 Endpoints and subscriptions

| purpose | endpoint / message |
|---|---|
| WebSocket | `wss://stream.bybit.com/v5/public/spot` |
| subscribe (one request) | `{"op":"subscribe","args":["orderbook.50.BTCUSDT","publicTrade.BTCUSDT"]}`; the acknowledgement (`"op":"subscribe","success":true`) is stored verbatim in the `subscribe` record |
| heartbeat | `{"op":"ping"}` every 20 s (recorded as `note` records; replies are `message` records) |
| instrument spec (manifest) | `GET https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT` verbatim; `priceFilter.tickSize` becomes `tickSize`, `lotSizeFilter.basePrecision` becomes `lotSize`; decimals derived from them; `aggressorSource: "taker_side"`, `tradeStreamGranularity: "per_fill"` (one element per execution as delivered by the venue) |
| optional cross-check snapshot | `GET /v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=1000` (has `u`, `seq`, `cts`); never used to build the book in the primary mode |
| clock probe | `GET /v5/market/time` (`timeNano`) at start, every 10 minutes and at end; send and receive clocks recorded around each probe in `note` records |
| fallback book stream | `orderbook.full.BTCUSDT` (delta-only, 200 ms) initialized from `GET /v5/market/full_orderbook` with the venue's documented `seq`/`u` procedure; selected with `--book-stream full` |

Connection budget: at most 5 reconnects per 5 minutes; beyond that the capture stops and records `ws_error` (the venue limits connections per IP). Every reconnect is a segment boundary.

### 8.2 Book messages

Payload shape (spot puts `ts` before `type`; parse by key, never by position):

```json
{"topic":"orderbook.50.BTCUSDT","ts":1687940967466,"type":"delta","data":{"s":"BTCUSDT","b":[["30247.20","30.028"],["30240.00","0"]],"a":[],"u":177400507,"seq":7961638724},"cts":1687940967464}
```

| adapter output | source |
|---|---|
| `kind` | `snapshot` when `type == "snapshot"`, else `depth` |
| `firstSeq`, `lastSeq` | both `data.u` (one id per message) |
| `venueTime` (fixture `marketTime`) | `cts` (matching-engine time). `ts` is kept in `venueSeq` as `"u:<u>;seq:<seq>;ts:<ts>"`. A message without `cts` is malformed |
| `bids`, `asks` | `data.b`, `data.a` as decimal strings; size `"0"` deletes the level |

Synchronization (contract §5.3 instantiated):

1. Messages before the first `snapshot` after a subscribe are counted (`dropped.depthBeforeSnapshot`) and not applied.
2. A `snapshot` replaces the local book and sets `localU = data.u`. A snapshot that arrives while a segment is open (including `u == 1`) ends the segment (`endReason: "gap_sequence"`, detail `"snapshot_reset"`) and starts a new one.
3. A `delta` with `data.u == localU + 1` is applied and `localU` advances. `data.u <= localU` is a duplicate (`dropped.depthDuplicate`). `data.u > localU + 1` is a gap: the segment ends at the last applied update; the capture tool, which checks the same condition live, unsubscribes and resubscribes to obtain a fresh snapshot.
4. `seq` must not decrease across applied messages; a decrease is recorded (`cuts` with reason `seq_regression`) and treated as a gap.
5. The local book holds at most the 50 levels the stream describes; the fixture emits the top `depth` (default 20) per applied message. Levels beyond 50 are unknown and are never invented.

Because the venue documents `u` contiguity for `orderbook.full` and only "reset" semantics for `orderbook.50`, the normalize report counts `sequenceJumps` for this stream. The acceptance session (handoff A12) must report that count; if it is not zero, the adapter's `--book-stream full` mode becomes the default and this section is amended.

### 8.3 Trade messages

```json
{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1672304486868,"data":[{"T":1672304486865,"s":"BTCUSDT","S":"Buy","v":"0.001","p":"16578.50","i":"20f43950-d8dd-5b31-9112-a178eb6023af","BT":false,"RPI":false,"seq":1783284617}]}
```

One `trade` event per array element, in array order (the venue sorts by match time). `marketTime = T`; `tradeId = i`; `aggressor = "buy"` when `S == "Buy"`, `"sell"` when `S == "Sell"`; `price = p`, `size = v`. Elements with `BT == true` (block trade) or `RPI == true` (executed against retail-price-improvement orders that are never shown in the book) are **not emitted**: they did not consume visible-book liquidity and would let the engine award fills against a queue that never existed. They are counted (`dropped.tradeOffBook`). Duplicates are keyed on `(s, i)`; `seq` is not a trade key (several messages can share one `seq`).

### 8.4 Clocks and lag

`marketTime` for books is `cts`, for trades `T`, both matching-engine milliseconds by the venue's description. Lag statistics are computed per stream against those fields. `ts` (publication) is retained in `venueSeq` for diagnostics only.

### 8.5 Instrument and scenario defaults

From the documented instrument example (re-fetched at capture): `tickSize 0.1`, `lotSize 0.000001`, `priceDecimals 1`, `qtyDecimals 6`. Recorded scenario: `makerFeeBps 10` (search-derived spot fee, swept by the sensitivity grid), `placementCost 0`, `cancelCost 0`, `policyTickMs 300`, `windowMs 3000`, `maxStalenessMs 500` (revisit against the session's `lagStatsMs`), `outcomeHorizonsMs [1000, 3000]`.

### 8.6 Appendix: alternate adapter, Binance spot BTCUSDT (`binance-spot-v3`)

Read from `binance/binance-spot-api-docs` at `828ca74b809c`. Market-data-only hosts: `wss://data-stream.binance.vision:443/stream?streams=btcusdt@depth@100ms/btcusdt@trade` (combined-stream frames are `{"stream": ..., "data": ...}`) and `https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=5000`; `GET /api/v3/exchangeInfo?symbol=BTCUSDT` for `PRICE_FILTER.tickSize` and `LOT_SIZE.stepSize`. Depth: `U` first id, `u` last id, `E` event time (publication of the 100 ms batch; there is no matching time on spot depth), `b`/`a` levels. Trades: `t` id, `p`, `q`, `T` trade time, `m` (buyer is maker: `aggressor = "sell"` when true, `"buy"` when false). Snapshot: `lastUpdateId`, no timestamp. Synchronization exactly as documented: buffer, snapshot, drop events with `u <= lastUpdateId`, first applied event must satisfy `U <= lastUpdateId + 1 <= u`, then `U == previous u + 1`; `U > local + 1` is a gap (restart). Timestamps are milliseconds by default; if `timeUnit=MICROSECOND` is used, the raw stays in microseconds, the fixture floors to milliseconds and the header records the unit. Connections are closed by the venue after 24 hours, so every day has at least one segment boundary. Same publication and jurisdiction conditions as Bybit.

## 9. Versioning

- Raw capture format: `captureFormatVersion` (integer). Any change to record types or clock semantics increments it; old raw files remain readable by keeping the old decoder.
- Fixture schema: `schemaVersion` 1 (synthetic, existing) and 2 (this document). Additive optional fields do not bump the version; a change to the meaning of `obsTime`, `marketTime`, `seq` or the header requirements does.
- Adapter: `adapter.version` in the header; a change to any field mapping or synchronization rule bumps it and re-normalization of existing raw files is expected to change fixture hashes (recorded in the normalize report).
- Ledger schema is unchanged (version 1).
