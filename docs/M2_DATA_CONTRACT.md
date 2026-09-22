# Milestone 2 data contract: from raw capture to replay fixture (v2)

Status: contract for implementation (see [M2_GROK_HANDOFF.md](M2_GROK_HANDOFF.md)). Venue and instrument: [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md) (Kraken spot `BTC/USD`, WebSocket API v2). Evaluation rules: [M2_EVALUATION_PROTOCOL.md](M2_EVALUATION_PROTOCOL.md). Machine-readable: `schemas/capture-record.v1.schema.json`, `schemas/fixture.v2.schema.json`.

Revision 2026-09-22: the venue changed from Bybit (whose official restricted-jurisdictions page excludes the United States, where this project is operated) to Kraken. The integrity gate is now the venue's per-message CRC32 book checksum (§8.2); no sequence number is assumed on book messages because the venue documents none. §5.5 records a numeric-precision prerequisite: the selected instrument's quantity increment (`1e-08`) is finer than the engine's `QTY_SCALE` (`1e-6`), so a separate, versioned fixed-point migration (handoff §0) must land before any recorded fixture of this instrument can be normalized.

The engine (Milestone 1) replays a JSONL fixture in which every observation carries `obsTime` (when the strategy could first know it) and `marketTime` (when it happened at the venue), consumes it lazily in file order, and rejects what it cannot trust (EVENT_SCHEMA.md). This contract says how such a fixture is produced from recorded market data so that those semantics remain true, and it **fails closed**: whenever a rule cannot be verified, no replay fixture is produced.

Two artifacts, one direction:

```
venue feed --(capture, first party)--> raw capture v1 (immutable) --(normalize)--> replay fixture v2 --(replay)--> ledger
```

## 1. `obsTime`: definition and prohibitions

`obsTime` is the **local wall-clock time, in integer milliseconds since the Unix epoch, at which the capture process finished receiving the raw frame that carries the observation**, taken by the capture process from the operating system's realtime clock at receipt and before any parsing.

Rules:

1. `obsTime` is never derived from any venue field: not the event time, not the trade time, not a block timestamp, not a checksum or sequence number, and not "venue time plus a typical latency".
2. Data without a receive timestamp recorded by an identified capture process (venue historical archives, exchange CSV dumps, database extracts) is **venue-time-only data**. It is never labelled `synthetic: false` with a replay time basis. The normalizer cannot prove that a receive clock is genuine; what it can do is refuse anything that does not come from a raw capture v1 file written by an identified capture tool (R1) and apply the plausibility checks of R1b. Converting an archive into raw capture v1 by inventing receive clocks is a violation of this contract, not a workaround.
3. The capture process records two clocks per record: `recvWallMs`, the realtime clock in integer milliseconds (`Date.now()` in Node, read independently of any monotonic source), and `recvMonoNs`, the monotonic clock in nanoseconds (`process.hrtime.bigint()`). `recvWallMs` becomes `obsTime`. Deriving the wall clock from the monotonic one (start time plus elapsed) is forbidden: the two must be able to disagree, because their disagreement is how clock steps are detected (§5.6).
4. The capture host runs a disciplined clock (NTP or PTP, e.g. `chronyd`). The manifest records the synchronization report at start and end (§4.2). `clockSync` is `synchronized` only if both reports show a synchronized state with `|offsetMs| <= 5`; otherwise `unknown`, and the evaluation protocol classifies the session's results as inconclusive (I6). The capture also probes the venue clock (§8.1) and the normalizer records the estimated host-to-venue offset and the probe resolution (§5.6); a host clock that runs behind the venue makes orders look live earlier than they were, so the bound is enforced where the probe resolution allows it and reported where it does not.
5. Third-party receive timestamps (a data vendor's own capture time) are a distinct time basis, `third_party_receive`. They are not "actual local receive time" and their latency distribution is not ours. The M2 build does **not** implement this basis: `validateHeader` rejects it with "time basis not implemented". When a later milestone adds it, the header must name the vendor, the capture location and the licence (schema: `provenance.capture.vendor` becomes required), the CLI banner and results must print the basis, and the evaluation protocol must report it separately.

`marketTime` is the venue's own timestamp for the event, in integer milliseconds, from the field the adapter names (§8.5). The selected venue stamps books and trades in RFC 3339 with microseconds; `marketTime` is that instant floored to the millisecond, and the full string is kept in `venueSeq`.

## 2. Capture path (first party, market data only)

No legitimately usable recorded session with receive timestamps exists for the selected venue (M2_DATA_SOURCE_DECISION.md §2, §3), so the session is produced by our own capture, from a host in a jurisdiction the venue serves (M2_DATA_SOURCE_DECISION.md §1, conditions):

- A capture process connects to the venue's **public** market-data endpoints only. No API key, wallet, account or order path exists in the capture code; the package must not contain order-placement code at all. This is a review criterion.
- It subscribes to the book channel (with the venue's in-band snapshot), the trade channel and the instrument channel of exactly one instrument (§8.1), and appends every received frame **verbatim** to the raw capture with both receive clocks, in arrival order. It never reorders, dedups, parses-and-drops, or rewrites.
- It records its own lifecycle (connect, disconnect, reconnect, every request it sends, clock probes, errors) as records in the same stream with receive clocks, so a normalizer can prove what was known when.
- It maintains the same local book as the normalizer, through one shared adapter module, and performs the same live checks: the per-message checksum of §8.2, a crossed local book and a malformed depth update (§5.3). On any of them it resubscribes (the `unsubscribe` echoing the subscribed depth, then `subscribe`), so that a fresh snapshot follows every cut the normalizer will make for those reasons; without that, the remainder of a capture after such a cut would be unusable. Clock steps (§5.6) need no resubscribe because the normalizer carries the book over. The live checks never change what is written: the frame that revealed the condition is appended verbatim like any other, and the cut itself is the normalizer's.
- Liveness: the venue sends a heartbeat about once per second when nothing else is flowing (§8.1). If no frame of any kind arrives for 15 s the capture closes the socket (`ws_close`, detail `liveness_timeout`) and reconnects; every reconnect is a segment boundary.
- It runs for a target duration (default 90 minutes) and rotates raw files at most hourly; every file is closed with its SHA-256.

A **usable session** is a capture segment that the normalizer accepts under §5 end to end: checksum-verified book on every applied update, no cut, non-negative lag floor, bounded venue clock offset where measurable, at least 60 minutes (evaluation) or 10 controller windows (acceptance tests), with the sync report present. The first usable session is the acceptance input for the M2 build.

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
| `manifest_start` | `captureFormatVersion: 1`, `captureId`, `venue`, `instrument` (venue-native symbol), `streams` (the subscription requests, verbatim), `endpoints` (`ws`, `rest`), `capturer` (`name`, `version`, `commit`), `host` (`os`, `runtime`; no hostnames or addresses), `clock` (§4.2), `instrumentSpec` (`source`, `fetchedAtIso`, `payload`: the verbatim REST instrument response, §8.4), `startedAtIso` | first record of file 0 |
| `file_start` | `fileIndex`, `previousFileSha256` | first record of every file after file 0 |
| `ws_open` / `ws_close` / `ws_error` | `detail` | connection lifecycle; a `ws_close` followed by `ws_open` is a reconnection |
| `subscribe` / `unsubscribe` / `ping` | `request` (verbatim text sent) | written at send time (the record's clocks are the send clocks); the venue's response arrives as an ordinary `message` record and is matched by `req_id` |
| `message` | `stream` (the frame's `channel`, or `method:<name>` for method responses, or `unknown`), `payload` | one received frame |
| `probe` | `url`, `sentWallMs`, `sentMonoNs`, `payload` | REST venue clock probe (fallback only, §5.6): request send clocks plus the verbatim response; the record's own clocks are the response receive time |
| `note` | `detail` | operator or tool note (clock step detected, checksum mismatch, resubscribe issued, liveness timeout, budget exhausted) |
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
decode(record) -> { kind: 'snapshot', checksum, venueTimeText?, venueTime?, bids: [[price,size]...], asks: [[price,size]...] }
              |  { kind: 'depth',    checksum, venueTimeText,  venueTime,  bids, asks }
              |  { kind: 'trades', history: boolean, items: [{ tradeId, price, size, venueTimeText, venueTime, aggressor: 'buy'|'sell'|'unknown', offBook: boolean, ordType }] }
              |  { kind: 'instrument', pairs: [{ symbol, text }] }      (each pair's verbatim JSON text)
              |  { kind: 'status', system }
              |  { kind: 'response', reqId, timeIn?, timeOut?, success? } (method responses: acks, pong)
              |  { kind: 'ignore', reason }                              (heartbeats, other channels)
              |  { kind: 'malformed', reason }
```

Prices, sizes and checksums are the **exact JSON lexemes** as received. The adapter parses with a lossless reviver (`JSON.parse(text, (key, value, context) => context.source)` for numbers; Node 21 or later, verified on the Node 22 line used by this repository) and never passes a price or size through binary floating point. A book or trade price or size whose lexeme contains an exponent, a sign, or more than one leading zero is `malformed` (the checksum rules of §8.2 assume plain decimal lexemes). `venueTime` is the RFC 3339 field floored to integer milliseconds; `venueTimeText` is the field verbatim.

The adapter also declares the instrument specification from the instrument channel's snapshot (§8.4), cross-checked against the manifest's REST payload: `venueSymbol`, `tickSize` (the price increment), `lotSize` (the quantity increment), `priceDecimals`, `qtyDecimals`, `qtyMin`, `costMin`, `costDecimals`, `status`, `aggressorSource` (`maker_flag` / `taker_side` / `none`), `tradeStreamGranularity` (`per_fill` / `aggregated`), `tradeIdOrdered` (boolean), `integrity` (`crc32_top10` / `sequence` / `none`), `source`, `fetchedAtIso`. Increments are written as plain decimal strings; an exponent lexeme in the instrument data (`1e-08`) is converted exactly.

### 5.2 Ordering and identity

- Fixture order is raw arrival order; within one raw record that carries several items (a trade frame), array order. `seq` is assigned 1, 2, 3... in emission order within a segment.
- `eventId = ${captureId}:${fileIndex}:${recordIndex}:${elementIndex}` (`elementIndex` 0 for records that carry one observation, the array index for multi-item frames). `rawRef = {fileIndex, record, element}`. Every eventId in a segment is unique by construction, so the engine's `duplicate_event` rule cannot fire on a correctly normalized fixture (acceptance A9/A11 assert this).
- `event.symbol` and `header.symbol` are the venue-native symbol (`BTC/USD`; `header.venueSymbol` repeats it); `event.venue` and `header.venue` are the adapter's venue name (`kraken-spot`).
- `obsTime = recvWallMs` of the record that carried the observation. The normalizer **asserts** `obsTime` non-decreasing across the events it emits and refuses the segment if the assertion fails (fail closed; it cannot happen if §5.6 is implemented, and the assertion is the proof).

### 5.3 Book synchronization and reconstruction

The normalizer maintains a full local book per segment from the venue's in-band snapshot plus its incremental updates, per the venue's documented procedure (adapter §8.2 instantiates it). Generic rules:

- **Snapshot.** The first `snapshot` after a `subscribe` replaces the local book. Its integrity value is verified (§8.2); a failed verification is a reconstruction failure (R6). The snapshot is **not** emitted as an event: a snapshot alone is not a verified stream position.
- **Update.** Each update is applied in full (a level with size zero removes the level; otherwise it replaces the level's size; a size-zero for a level the local book does not hold is a no-op counted as `dropped.deleteOfUnknownLevel`), each side is then truncated to the subscribed depth (the venue does not send removals for levels that fall out of scope), and only then is the integrity value computed over the post-apply state and compared with the message's. A mismatch is a cut (`endReason: checksum_mismatch`, §5.8) at the raw record before the mismatching message; the mismatching message is not applied and nothing after it is applied until the next snapshot (`dropped.depthWhileUnsynced`).
- **First event.** The segment's first `book` event is the first verified update after the snapshot. A snapshot never followed by a verified update before the next snapshot, `ws_close` or end of capture is `reconstruction_failure` (the segment is refused).
- **Every verified update emits one `book` event**, whether or not the top `depth` levels changed, so the policy's book age (`maxBookAgeMs`) reflects what the feed delivered. Its `obsTime` is the update's receive time and its `marketTime` the update's venue time. The event carries the top `depth` levels of the local book (`--depth`, default 100 for this venue, never more than the subscribed depth). Levels beyond the subscribed depth are unknown and never invented.
- **Visible span.** Because the policy's queue model seeds a level absent from the visible book with a queue of zero (EXECUTION_MODEL.md), the normalizer records per segment the distance in basis points from mid to the worst emitted level on each side (`visibleSpanBps.bid` / `.ask`, `p1` and `p50` over book events). The evaluation protocol uses it (I8).
- A crossed reconstructed book (best bid `>=` best ask) is a reconstruction failure (R6). The engine's own `crossed_book` rejection remains as a second line. The capture tool detects the same condition live on the same local book and resubscribes (§2, §8.1), so a fresh snapshot follows; the normalizer cuts here regardless of what the capture did.
- **Reset.** A `snapshot` that arrives while a segment is open (the venue re-sends one after a resubscribe or a reconnect) ends the segment (`endReason: snapshot_reset`) and starts a new one.
- No update is ever buffered and applied later: on this venue the snapshot arrives in band before any update of the subscription, so every applied update is emitted at its own receive time. An adapter for a venue that needs buffering must add its own rule here and bump the adapter version (§9).

### 5.4 Trades and aggressor side

Each trade item emits one `trade` event with `marketTime` = the venue's trade time, `tradeId` = the venue's trade id as a string, `aggressor` per the adapter. If the venue gives no aggressor information the value is `unknown` and `instrumentSpec.aggressorSource` is `none`; the engine treats `unknown` prints as able to fill either side, which is the more pessimistic picture. The selected venue names the taker side explicitly (§8.3).

A trade frame whose `type` is `snapshot` carries recent history, not new prints; it is never emitted and is counted (`dropped.tradeSnapshotHistory`). Items the adapter marks `offBook: true` (block trades, trades against hidden order types that never appear in the book) are **not emitted**: they did not consume visible-book liquidity and would let the engine award fills against a queue that never existed. They are counted (`dropped.tradeOffBook`). The selected venue's trade channel has no such flag; `offBook` is always false there.

Limitations recorded in the header: whether the trade stream is per-fill or aggregated (an aggregated stream can merge several fills of one taker order into one print; the M1 rule "a fill is never larger than the printed trade size" then bounds by the merged size), and which venue clock each stream carries (§5.6). The selected venue documents that one message may batch several trades and that batching does not imply one taker order (§8.3), so the stream is `per_fill`.

### 5.5 Price and quantity conversion (exactness, and the precision prerequisite)

The engine is fixed point on `bigint` (`src/core/money.ts`): `PRICE_SCALE`, `QTY_SCALE` and `MONEY_SCALE` are powers of ten, and `parseDecimal` **refuses** any decimal string with a non-zero digit beyond the scale's places. Nothing is rounded or truncated on the way in, ever.

Exactness condition. Every valid price of an instrument is an integer multiple of its price increment and has at most `priceDecimals` decimal places; it maps into the engine exactly if and only if `priceDecimals <= decimalsOf(PRICE_SCALE)`. Likewise every valid quantity maps exactly if and only if `qtyDecimals <= decimalsOf(QTY_SCALE)`. Notional (`price * qty`) is rounded half-up to `MONEY_SCALE` by the engine's documented accounting rule; the venue's `costDecimals` bounds nothing on our side.

Evidence for the selected instrument (Kraken `BTC/USD`, instrument-channel example in the venue's documentation; re-fetched verbatim at every capture and cross-checked, §8.4; source labels in M2_DATA_SOURCE_DECISION.md §5):

| quantity | venue value | engine scale today | exact today? | after handoff §0 (`QTY_SCALE = 1e-8`) |
|---|---|---|---|---|
| `price_precision` / `price_increment` | 1 / `0.1` | `PRICE_SCALE = 1e-6` (6 places) | yes (1 <= 6) | yes |
| `qty_precision` / `qty_increment` | 8 / `1e-08` | `QTY_SCALE = 1e-6` (6 places) | **no** (`0.00000001` is `0.01` units) | yes (8 <= 8) |
| `cost_precision` | 5 | `MONEY_SCALE = 1e-6` | not a constraint | not a constraint |

Consequences, all fail closed:

- R5 refuses to normalize any capture whose `instrumentSpec.priceDecimals` exceeds `decimalsOf(PRICE_SCALE)` or whose `qtyDecimals` exceeds `decimalsOf(QTY_SCALE)` of the engine that runs the normalizer. On the current engine this refuses `BTC/USD`. No rounding mode exists.
- The versioned migration `QTY_SCALE: 1e-6 -> 1e-8` is a **prerequisite** for this instrument, specified in M2_GROK_HANDOFF.md §0 as its own PR. It is not part of this documents-only PR and not part of the capture/normalize PR.
- Substituting an instrument that fits today (`qty_precision <= 6` and `price_precision <= 6`) would avoid the migration; no such Kraken instrument has been verified from the authoring environment (no instrument listing was reachable), and the evaluation objective (a liquid USD spot market) keeps `BTC/USD` selected. The handoff §0 check enumerates fitting pairs from a live instrument snapshot before the migration is started, so the owner can still choose.
- The cross-check of §8.4 (REST `pair_decimals`, `lot_decimals`, `tick_size` against the instrument channel's `price_precision`, `qty_precision`, `price_increment`) must agree; a disagreement is R5.

Malformed items (R4): a price that is not a multiple of `tickSize`, or a size that is not a multiple of `lotSize`, is not emitted and counted (`dropped.offTickPrice`, `dropped.offLotSize`); a non-positive trade size is `dropped.nonPositiveTradeSize`; an undecodable frame is `dropped.undecodable`. A malformed **depth** update cuts the segment (R6) because the book can no longer be trusted. Header and event decimals are written through `fmtPrice`/`fmtQty` at the engine's scales; `instrumentSpec` keeps the venue's values as plain decimal strings.

### 5.6 Clock basis, skew and steps

- Venue time and receive time are on different clocks. The lag `obsTime - marketTime` is network latency plus the venue's publication delay plus the host-to-venue clock offset. The normalizer computes, per segment and per stream (`book`, `trade`), `lagStatsMs = {count, min, p1, p50, p99, max}` and writes it into the header.
- **Venue clock offset, millisecond probes (WebSocket method responses).** The venue's method responses carry `time_in` (request received on the wire) and `time_out` (response sent on the wire), RFC 3339 with microseconds; this is documented for subscription acknowledgements and modelled in the venue's official CLI for order methods, while for `pong` the documentation excerpt shows the fields and the official CLI models none (M2_DATA_SOURCE_DECISION.md §2, item 12), so the build assumes them on **no** response and uses every response that carries them. Every request the capture sends (`subscribe`, `unsubscribe`, `ping`, §4.1) is a candidate probe: with `t0 = ` the request record's `recvWallMs` (its send clock), `t1 = time_in`, `t2 = time_out`, `t3 = ` the response record's `recvWallMs`, matched by `req_id`, the offset sample is `((t1 - t0) + (t2 - t3)) / 2` and the round trip `(t3 - t0) - (t2 - t1)`. The capture sends a `ping` every 30 s. When a segment holds at least 3 such samples the normalizer records `venueClockOffsetMs = {samples, medianMs, medianRttMs, maxAbsMs, resolutionMs: 1, source: "ws_method_response"}` and R2b refuses the segment if `|medianMs| > 50` or `medianRttMs > 500`. The sign matters: a host clock behind the venue makes our orders appear live earlier on the venue clock than they were (optimistic eligibility); the evaluation protocol treats `|medianMs| > 25` as inconclusive (I6).
- **Coarse probe (REST, always on).** The capture also issues `GET /0/public/Time` every 10 minutes as `probe` records. That endpoint returns whole seconds (`unixtime`), so its estimate has `resolutionMs: 1000`. When a segment has fewer than 3 millisecond samples the header records the coarse estimate with `source: "rest_time"`, R2b only refuses gross errors (`|medianMs| > 2000` or `medianRttMs > 1000`), and the protocol's I6 uses the lag floor instead of the offset. A segment with neither kind of sample records `samples: 0`, `source: "none"` and is refused (R2b).
- **Negative lag floor.** If more than 0.1% of a segment's events have `obsTime < marketTime`, the segment is refused (R2). The remaining few are left as they are and the engine rejects them (`invalid_timestamps`), which the ledger records. `obsTime` is never shifted.
- **Wall-clock steps.** For consecutive raw records (across file rotation; the normalizer carries the previous file's last clocks itself), let `Δwall = recvWallMs[i] - recvWallMs[i-1]` and `Δmono = (recvMonoNs[i] - recvMonoNs[i-1]) / 1e6`. Any `Δwall < 0`, or `|Δwall - Δmono| > 10` ms, is a clock cut (R3) at record `i`: the segment ends at record `i-1`, and record `i` is the first record of the next segment (`startReason: resync_after_clock_cut`), which continues with the checksum-verified local book (no fresh snapshot is needed because every later update is verified on its own). `recvMonoNs` must be strictly increasing; a non-increase is R1b.
- Different venue streams may carry different venue clocks; the adapter states which field it uses per stream and the header records both names (§8.5).

### 5.7 Duplicates

- **Book.** The selected venue documents no sequence number on book messages, so a duplicated update cannot be identified as such; an idempotent re-send applies to the same state, verifies against its checksum and is emitted as what the feed delivered. `dropped.depthDuplicate` is always 0 for this adapter and is kept in the schema for adapters with sequence numbers.
- **Trades.** `tradeId` is the venue's `trade_id`, documented as a sequence number unique per book (`tradeIdOrdered: true`). A trade whose id equals one already emitted in the segment is `dropped.tradeDuplicate`; a lower id is `dropped.tradeIdRegression`; an id that skips ahead is counted (`tradeIdJumps`) but is not a cut, because contiguity is not documented and must not be invented.

### 5.8 Gaps, cuts, segments and reconnection

- A cut is any of: a checksum mismatch (§5.3), a crossed or malformed book (R6), a snapshot arriving while a segment is open (reset), any `ws_close`/`ws_error` before the next `ws_open`, or a clock step (R3). The segment then **ends at the raw record immediately before the record that revealed the condition**: every event carried by earlier records is emitted (trades between the last applied update and the revealing record included; they are matched against the last verified book, as any inter-update trade is), and `capture.endRawRecord` is that index. No book event is emitted from unverified state and nothing after the cut is attached.
- After a reconnection or resubscription the venue sends a fresh snapshot; the normalizer starts a **new segment** at the first verified update after it (new fixture file, `segmentIndex + 1`). Segments are never stitched.
- Segment reasons. `endReason` is one of `capture_end`, `checksum_mismatch`, `snapshot_reset`, `gap_disconnect`, `clock_cut`, `reconstruction_failure` (snapshot checksum failed, snapshot never followed by a verified update, crossed book), `malformed_depth`, and `gap_sequence` (reserved for adapters with sequence numbers; never produced by this adapter). `startReason` of the next segment is `capture_start` for the first segment, `resync_after_clock_cut` after `clock_cut`, and `resync_after_gap` after every other reason. Every cut is listed in `capture.cuts` with `{reason, fileIndex, record, detail}`.
- Trades observed while no verified book exists (before the first verified update of a segment, or after a cut until the next one) are not emitted; they are counted (`dropped.tradeWhileUnsynced`).

### 5.9 Rejection and fail-closed rules

| rule | condition | effect |
|---|---|---|
| R1 | raw manifest missing, `captureFormatVersion` unsupported, records lacking `recvWallMs`/`recvMonoNs`, or `capturer` identity absent | no fixture; error names the missing field |
| R1b | recomputed file SHA-256 differs from `file_end.sha256` or from `manifest_end.files`; `recvMonoNs` not strictly increasing; any `recvWallMs` outside `[manifest_start.startedAtIso - 60 s, manifest_end.endedAtIso + 60 s]` | no fixture; error names the file and record |
| R2 | negative lag floor breached (§5.6) | segment refused; diagnostics written |
| R2b | venue clock offset or probe round-trip beyond the bound for the probe resolution (§5.6) | segment refused |
| R3 | wall-clock step (§5.6) | segment cut at the record |
| R4 | undecodable frame, off-tick price, off-lot size, non-positive trade size | item not emitted, counted by key; a malformed depth update triggers R6 |
| R5 | instrument decimals exceed the engine's scales; instrument spec missing from the manifest or the instrument channel; REST and channel specifications disagree (§5.5, §8.4) | no fixture; error names the field and both values |
| R6 | book cannot be reconstructed: snapshot checksum failed, no verified update after a snapshot, update checksum mismatch, crossed reconstructed book, malformed depth update | segment cut at the last verified book, or refused if none was verified |
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
| `priceScale`, `qtyScale` | always | the engine's constants at normalization time (`1000000` today; `qtyScale` becomes `100000000` after handoff §0); sizes are written with `decimalsOf(qtyScale)` places |
| `provenance.timeBasis.obsTime` | always | `"capture_receive"` for first-party captures; `"third_party_receive"` is reserved and rejected by this build; synthetic fixtures keep their descriptive string |
| `provenance.timeBasis.marketTime` | always | the venue field(s) used per stream and their resolution (§8.5) |
| `provenance.instrumentSpec` | `synthetic: false` | §5.1 fields |
| `provenance.capture` | `synthetic: false` | `captureId`, `captureFormatVersion`, `rawFiles: [{fileIndex, sha256, records}]`, `segmentIndex`, `startReason`, `endReason`, `endRawRecord: {fileIndex, record}`, `capturer` / `normalizer` (`name`, `version`, `commit`), `adapter` (`name`, `version`), `clockSync` (`synchronized` / `unknown`), `clockReports: {start, end}` (§4.2 blocks), `venueClockOffsetMs` (§5.6, with `resolutionMs` and `source`), `lagStatsMs: {book, trade}`, `integrity: {checksumsVerified, checksumMismatches}`, `visibleSpanBps: {bid: {p1, p50}, ask: {p1, p50}}`, `tradeIdJumps`, `venueStatus` (list of `{record, system}` for every status frame whose `system` is not `online`), `dropped` (counts by key), `cuts` (list) |
| `provenance.rights` | `synthetic: false` | §6.3 |
| `startTime`, `endTime` | always | `startTime` is the `obsTime` of the segment's first emitted event (no rounding; the engine aligns windows to it), `endTime` the `obsTime` of the last emitted event |
| `synthetic`, `syntheticLabel`, `eventCount`, `tickSize`, `lotSize` | unchanged | unchanged semantics |

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

The block is supplied to the normalizer as a file (`--rights <path>`); it is not part of the raw capture. A recorded fixture is committed to this public repository only when `publication` is `sample_permitted` **and** `redistribution` is `permitted`, with the terms URL and the date a person checked them. Everything else stays outside the repository; the repository carries the fixture's content hash, the raw files' hashes and the normalize report. A repository test enumerates `fixtures/*.jsonl` and fails on any `synthetic: false` fixture that violates this rule. Until the venue's terms are read in full by a person and found to establish the right (M2_DATA_SOURCE_DECISION.md §2, "storing captures" and "publishing samples"), the only admissible block for this venue is `redistribution: "unclear"` or `"prohibited"` with `publication: "hash_only"`, and raw captures never enter Git (`.gitignore` covers the capture and normalize output directories; the repository test is the second line).

### 6.4 Validation additions

`validateHeader`: version 2 requires `depth`, `venueSymbol` and both `timeBasis` strings; `synthetic: false` requires version 2, `provenance.source === "recorded"`, `provenance.recordedFrom`, `provenance.captureMethod`, `provenance.capture`, `provenance.instrumentSpec` (with `integrity`), `provenance.rights`, and `provenance.timeBasis.obsTime === "capture_receive"` (`third_party_receive` rejected as not implemented). Version 1 keeps today's rules. Everything the engine validates per event (EVENT_SCHEMA.md) is unchanged.

## 7. What the engine does with a v2 fixture

The replay path is unchanged. `replay_started` records `fixture.provenance` (now carrying capture identity, raw hashes, clock reports, lag statistics, integrity counts, drop counts, instrument specification and the rights block) and the fixture content hash. Presentation changes that are part of the build (handoff S4): the run summary's and `results.json`'s disclaimers branch on `header.synthetic` (recorded wording: paper execution on recorded observations, not evidence of profitability); `results.json` gains a per-run `config` block copied from `replay_started.config` so fees, message costs, latencies and `maxStalenessMs` are readable without the ledger; `results.json` gains per run `quotesOutsideVisibleBook: {count, ofLive}`, computed by the CLI without any engine change: for each `order_live` entry (`liveAt`, `side`, `price`) the CLI takes the last fixture `book` event with `obsTime <= liveAt` whose `eventId` has no `observation_rejected` entry in the same ledger (the book the engine used at activation) and counts the order when its price is beyond that book's worst emitted level on its side (below the last bid for a buy, above the last ask for a sell), or when that book side is empty; and the console header for a recorded fixture prints the staleness limit, `lagStatsMs`, `clockSync`, `venueClockOffsetMs` with its resolution, the integrity counts and the rights summary.

## 8. Venue adapter: Kraken spot `BTC/USD` (`adapter.name = "kraken-spot-ws2"`, `adapter.version = "1"`)

Sources: the venue's official SDK repositories at pinned commits (`krakenfx/api-go` `a8484bc5ec98`, `krakenfx/kraken-cli` `aa56e5976be5`, `krakenfx/kraken-api-sdk` `a5d253c02036`), read on 2026-09-22, for endpoints, message types and the checksum implementation; the venue's documentation pages (blocked from the authoring environment) for the remaining semantics through search excerpts. Every item's label is in M2_DATA_SOURCE_DECISION.md §2 and §5; anything marked [S] there must be re-read on the live page before the first capture.

### 8.1 Endpoints, subscriptions and live behaviour

| purpose | endpoint / message |
|---|---|
| WebSocket (public, no key) | `wss://ws.kraken.com/v2` |
| book subscription | `{"method":"subscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":100,"snapshot":true},"req_id":1}` (depth options are 10, 25, 100, 500, 1000; 100 gives headroom over the 10 levels the checksum covers) |
| trade subscription | `{"method":"subscribe","params":{"channel":"trade","symbol":["BTC/USD"],"snapshot":false},"req_id":2}` (`snapshot: true` would deliver recent history, which §5.4 drops anyway) |
| instrument subscription | `{"method":"subscribe","params":{"channel":"instrument","snapshot":true},"req_id":3}`; the snapshot frame is the instrument specification (§8.4); later `update` frames are kept as records and reported |
| acknowledgements | `{"method":"subscribe","result":{"channel":"book","depth":100,"snapshot":true,"symbol":"BTC/USD"},"success":true,"time_in":"...","time_out":"...","req_id":1}`; a `success: false` on any of the three subscriptions aborts the capture with `ws_error` |
| status | pushed by the venue on every connect: `{"channel":"status","type":"update","data":[{"api_version":"v2","connection_id":...,"system":"online","version":"2.0.0"}]}`; `system` is one of `online`, `maintenance`, `cancel_only`, `post_only`, `limit_only`; a non-`online` value is recorded (`note`) and reported (`venueStatus`), not a cut |
| heartbeat | `{"channel":"heartbeat"}` about once per second in the absence of other channel updates; liveness timeout 15 s (§2) |
| venue clock probe (ms) | `{"method":"ping","req_id":<n>}` every 30 s (the interval the venue's official CLI uses), written as a `ping` record; the `pong` response is a `message` record; §5.6 uses `time_in`/`time_out` of every method response that carries them, subscription acknowledgements included |
| instrument spec (manifest) | `GET https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD` once, before the socket opens, verbatim into `manifest_start.instrumentSpec.payload` (`pair_decimals`, `lot_decimals`, `tick_size`, `ordermin`, `costmin`, `status`); cross-checked against the instrument channel (§8.4) |
| venue clock probe (coarse) | `GET https://api.kraken.com/0/public/Time` (`unixtime`, whole seconds) every 10 minutes as `probe` records (§5.6) |
| unsubscribe (resync) | `{"method":"unsubscribe","params":{"channel":"book","symbol":["BTC/USD"],"depth":100},"req_id":<n>}` (the depth must be echoed), then the book subscription again with a new `req_id` |

Connection budget: at most 5 reconnects per 5 minutes; beyond that the capture stops and records `ws_error` (the venue limits simultaneous connections per client and rejects clients that reconnect too often; a documentation excerpt names a per-IP cap of about 150 connection attempts per rolling 10 minutes with a 10-minute ban beyond it, unverified on the live page). Public REST calls are kept to one `AssetPairs` request at start and one `Time` request per 10 minutes (the venue's guidance for public endpoints is about one request per second). The 15 s liveness timeout of §2 is stricter than the venue's official CLI (which pings every 30 s and treats 90 s of silence as a dead socket); with heartbeats about once per second it costs nothing. Every reconnect is a segment boundary.

Live checks the capture performs, on the same local book the normalizer builds (one shared adapter module holds the decode, book and checksum logic): the checksum of every book message (§8.2), the crossed-book check and the malformed-depth check of §5.3 (on a mismatch, a crossed book or a malformed update it records a `note` naming the condition, sends the `unsubscribe` above, then `subscribe`, so a fresh in-band snapshot follows), and the clock-step rule of §5.6 (recorded as a `note`; no resubscribe needed). A resubscribe never rewrites or withholds anything: the revealing frame is appended verbatim, the `unsubscribe` and `subscribe` records carry their own send clocks, and the normalizer makes the cut from the raw stream alone. The snapshot that follows the resubscribe starts the next segment (§5.3, reset rule).

### 8.2 Book messages and the checksum

Decode dispatches on `channel` first: `book` frames are book messages, `trade` frames are trade messages (§8.3), `instrument` and `status` frames are handled per §8.4, `heartbeat` is `ignore`, frames with `method` are method responses (§5.6). Parse by key, never by position.

```json
{"channel":"book","type":"snapshot","data":[{"symbol":"BTC/USD","bids":[{"price":62710.4,"qty":0.01000000}],"asks":[{"price":62710.5,"qty":0.93111634}],"checksum":1361442827}]}
{"channel":"book","type":"update","data":[{"symbol":"BTC/USD","bids":[{"price":62710.4,"qty":0.01},{"price":62709.1,"qty":0.0}],"asks":[{"price":62710.5,"qty":0.93111634}],"checksum":1361442827,"timestamp":"2026-07-09T17:20:01.123456Z"}]}
```

(The `update` line is the venue's own test vector from `kraken-cli`; the snapshot line has the documented shape with illustrative values. A snapshot may or may not carry `timestamp`; the adapter treats it as optional and §5.3 never emits the snapshot.)

| adapter output | source |
|---|---|
| `kind` | `snapshot` when `type == "snapshot"`, `depth` when `type == "update"`; anything else is `malformed` |
| `checksum` | `checksum`, the lexeme of an unsigned 32-bit integer; absent is `malformed` |
| `venueTimeText`, `venueTime` (fixture `marketTime`) | `timestamp` (RFC 3339, microseconds) verbatim and floored to ms; absent on an `update` is `malformed` |
| `venueSeq` | `"ts:<timestamp>;crc:<checksum>"` |
| `bids`, `asks` | `data[0].bids`, `data[0].asks` as `[price lexeme, qty lexeme]` pairs; a `qty` lexeme equal to zero (`0`, `0.0`, `0.00000000`) deletes the level |

`data` carries exactly one element for a single-symbol subscription; more than one element, or a `symbol` other than the subscribed one, is `malformed`.

**Checksum (the integrity gate), as implemented by the venue's official Go SDK (`api-go/pkg/book/checksum.go`, `L2Checksum`) and described in its Rust SDK guide (`kraken-api-sdk/rust/docs/guides/order-book.md`, "Checksum"):**

1. After applying the message (and truncating to the subscribed depth), take the top 10 asks from the lowest price upwards, then the top 10 bids from the highest price downwards (fewer if a side has fewer levels).
2. For each level, take the **wire lexeme** of the price, remove the decimal point, then strip all leading `0` characters; do the same with the wire lexeme of the quantity; append price then quantity. A level's lexemes are the ones from the message that last set that level (a snapshot or an update); this is why §5.1 keeps lexemes and never reformats. (Example from the venue's guide: price `45285.2` -> `452852`; quantity `0.00100000` -> `100000`.)
3. Concatenate the ask string then the bid string and compute CRC32 (IEEE 802.3 polynomial, the `zlib`/`binascii` CRC-32, as an unsigned 32-bit integer). It must equal the message's `checksum`.

Test vectors. (1) The venue's documented worked example, pinned by the venue's official Rust SDK test `amendment_59_worked_example_matches_canon` (`kraken-api-sdk/rust/src/book/checksum_tests.rs`, lines 30 to 39, commit `a5d253c02036`): the 281-character concatenation `45285210000045286415457195345286615457110945289615456091145290215890660452918154553491452947445474945296135380000452975994554245299518772827452835100000004528341545820154528211000000045281010000000452803154592586452790799000045277633101034527753000000045277315460273745276615445238` has CRC32 `3310070434`; the same file pins the strip rules `45285.21000000 -> 4528521000000`, `0.00159953 -> 159953`, `0 -> ` (empty), `0.0 -> ` (empty), `0.000123 -> 123`. Recomputed on 2026-09-22 with Python `binascii.crc32`: `3310070434`. (2) A five-level vector computed by this contract's author with two independent CRC32 implementations (Node `zlib.crc32` and Python `binascii.crc32`), for a book holding asks `[62710.5 x 0.93111634, 62710.6 x 0.50000000, 62711.0 x 1.20000000]` and bids `[62710.4 x 0.01000000, 62709.1 x 2.00000000]`: the string is `62710593111634627106500000006271101200000006271041000000627091200000000` and the checksum is `1396696505`. The handoff's tests use both (A9); the `checksum` in the update frame above covers a fuller book than the two levels shown and is not reproducible from them.

Synchronization (contract §5.3 instantiated):

1. Messages before the first `snapshot` after a subscribe are counted (`dropped.depthBeforeSnapshot`) and not applied.
2. A `snapshot` replaces the local book (both sides, truncated to the subscribed depth) and its checksum is verified; a failure is `reconstruction_failure`. No event is emitted.
3. An `update` is applied per §5.3, each side truncated to the subscribed depth, the checksum computed and compared. Equal: one `book` event is emitted. Different: the segment ends at the previous record (`checksum_mismatch`); the update is not applied; everything until the next `snapshot` is `dropped.depthWhileUnsynced`.
4. A crossed local book after an applied update is `reconstruction_failure` (the update is not emitted; the segment ends at the previous record).
5. A `snapshot` while a segment is open is `snapshot_reset` (the segment ends at the previous record; the snapshot opens the next one).
6. The fixture emits the top `depth` (default 100) levels per side; `visibleSpanBps` is computed over emitted events.
7. A `snapshot` never followed by a verified `update` before the next `snapshot`, `ws_close` or end of capture is `reconstruction_failure`: the segment is refused.
8. No sequence rule exists for this channel and none is applied; the checksum on every message is the only stream-position proof, and it is checked on every message (a documentation excerpt describes verification as optional; this repository does not treat it as optional).

### 8.3 Trade messages

```json
{"channel":"trade","type":"update","data":[{"symbol":"BTC/USD","side":"buy","price":62710.5,"qty":0.00120000,"ord_type":"market","trade_id":81234567,"timestamp":"2026-07-09T17:20:01.130001Z"}]}
```

(Field names and types from the venue's official `kraken-cli` type `TradeData`; values illustrative.) One `trade` event per array element, in array order. `marketTime = timestamp` floored to ms (`venueTimeText` keeps the string); `tradeId = trade_id` as a decimal string (`tradeIdOrdered: true`, §5.7); `aggressor = "buy"` when `side == "buy"`, `"sell"` when `side == "sell"` (the venue's official Rust SDK documents `side` as "Aggressor (taker) side of the print", `kraken-api-sdk` `rust/src/api/market/ws_types.rs:81-84,108-119`; the documentation page says "the side of the taker order"), anything else `malformed`; `price`, `size` are the lexemes of `price`, `qty`; `venueSeq = "id:<trade_id>;ts:<timestamp>"`; `ordType` is kept in the normalize report's counts (`limit` / `market` taker orders) and not in the fixture. A frame with `type == "snapshot"` is history (§5.4) and is not emitted. Several trades in one frame are several events with distinct `elementIndex` (§5.2); the venue documents that batching does not imply one taker order, so nothing is merged. Duplicates and regressions are keyed on `trade_id` per segment (§5.7).

### 8.4 Instrument and status frames

The `instrument` snapshot frame (`{"channel":"instrument","type":"snapshot","data":{"assets":[...],"pairs":[...]}}`) is the instrument specification. The adapter extracts the verbatim JSON text of the `pairs` element whose `symbol` is `BTC/USD` (`kind: 'instrument'`) and maps:

| `instrumentSpec` | source field | example (documentation, re-fetched at capture) |
|---|---|---|
| `venueSymbol` | `symbol` | `BTC/USD` |
| `tickSize` | `price_increment` (`tick_size` is deprecated by the venue and is only cross-checked when present) | `0.1` |
| `lotSize` | `qty_increment`, exponent lexemes converted exactly | `1e-08` -> `0.00000001` |
| `priceDecimals` / `qtyDecimals` / `costDecimals` | `price_precision` / `qty_precision` / `cost_precision` | 1 / 8 / 5 |
| `qtyMin` / `costMin` | `qty_min` / `cost_min` | `0.0001` / `0.5` |
| `status` | `status` (`online`, `cancel_only`, `post_only`, `limit_only`, `reduce_only`, `maintenance`, `work_in_progress`, `delisted`) | `online` |
| `aggressorSource`, `tradeStreamGranularity`, `tradeIdOrdered`, `integrity` | fixed by this adapter | `taker_side`, `per_fill`, `true`, `crc32_top10` |
| `source`, `fetchedAtIso` | the raw record reference and its receive time | |

Cross-check against the manifest's REST `AssetPairs` payload for the same pair: `pair_decimals == price_precision`, `lot_decimals == qty_precision`, `tick_size == price_increment`; a disagreement, a missing pair in either source, or a pair `status` other than `online` at capture start is R5. A later `instrument` `update` frame that changes this pair's `status` is recorded in `venueStatus` and reported; the fixture header keeps the start-of-capture specification.

`status` frames (§8.1) are `kind: 'status'`; every value other than `online` is listed in `capture.venueStatus` with its raw record index.

### 8.5 Clocks and lag

`marketTime` for books is the update's `timestamp`, for trades the trade's `timestamp`; both are RFC 3339 strings with microsecond resolution floored to milliseconds (`provenance.timeBasis.marketTime` states this). The venue does not document which clock stamps them; the lag statistics are computed per stream and the venue clock offset from method responses (`time_in`/`time_out`) per §5.6.

### 8.6 Instrument specification and the recorded scenario

From the documentation example (re-fetched verbatim at capture and cross-checked, §8.4): `tickSize "0.1"`, `lotSize "0.00000001"`, `priceDecimals 1`, `qtyDecimals 8`, `qtyMin "0.0001"`, `costMin "0.5"`. The `recorded` scenario takes `tickSize` and `lotSize` from the fixture header (`parsePrice`/`parseQty`) into **all three** configuration sites (`execution`, `policy`, `risk`) at replay time, checks them against `provenance.instrumentSpec`, and uses BTC/USD-scaled values:

| field | value |
|---|---|
| `policy.baseQuoteQty` | 0.001 BTC (above `qtyMin`); `baseHalfSpreadBps 1`, `maxBookAgeMs 1000`, `requoteThresholdTicks 2` |
| `initialCash` | 10 000 USD |
| `risk.maxPosition` / `maxOrderQty` / `maxLoss` | 0.005 BTC / 0.002 BTC / 20 USD |
| `execution.makerFeeBps` | the venue's published maker rate for the lowest spot fee tier on the capture day, read by a person from the fee page and recorded in the run notes (M2_DATA_SOURCE_DECISION.md §2 gives the search-derived value and its label); swept by the sensitivity grid |
| `execution.placementCost` / `cancelCost` | 0 |
| `execution.orderLatencyMs` / `cancelLatencyMs` | 50 / 50 |
| `policyTickMs` / `windowMs` / `controllerDeadlineMs` | 300 / 3000 / 200 |
| `maxStalenessMs` / `outcomeHorizonsMs` | 500 (revisit against `lagStatsMs`) / [1000, 3000] |

`baseHalfSpreadBps` is 1 rather than the synthetic default of 5 because at this instrument's price a 5 bps half-spread would rest quotes far outside the visible book, where the queue model has nothing to seed from (§5.3, visible span; protocol I8).

### 8.7 Other adapters

None is specified. Bybit and Binance are rejected on jurisdiction, Coinbase on its market-data terms, and the remaining candidates on data mechanics (M2_DATA_SOURCE_DECISION.md §3); no fallback stream exists on this venue beyond the book channel at another depth, which needs no adapter change.

## 9. Versioning

- Raw capture format: `captureFormatVersion` (integer). Any change to record types or clock semantics increments it; old raw files remain readable by keeping the old decoder.
- Fixture schema: `schemaVersion` 1 (synthetic, existing) and 2 (this document). Additive optional fields do not bump the version; a change to the meaning of `obsTime`, `marketTime`, `seq` or the header requirements does.
- Engine fixed-point scales: a change to `PRICE_SCALE`, `QTY_SCALE` or `MONEY_SCALE` is a versioned engine change (handoff §0): it changes the width of decimal strings in ledgers and results, so it bumps `LEDGER_SCHEMA_VERSION`, updates LEDGER_SCHEMA.md and ACCOUNTING.md, and is recorded in every fixture header's `qtyScale`/`priceScale`. Committed version-1 fixtures stay byte-identical; the loader rescales exactly, and `toWire`/`fixtureContentHash` format sizes at the fixture header's declared `qtyScale`, so version-1 content hashes do not change.
- Adapter: `adapter.version` in the header; a change to any field mapping or synchronization rule bumps it, and re-normalization of existing raw files is expected to change fixture hashes (recorded in the normalize report).
- Ledger schema is unchanged by the capture/normalize PR (version 1); only the precision migration bumps it.
