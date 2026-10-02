# C5 research note, 2026-10-02 (documentation only, not a C5 reading)

Access date: 2026-10-02. This note covers documentation pages only. No API was called, no WebSocket connection was opened, no live response was read, and no market data was read, retained, or recorded for it.

The quoted sentences below were read from the official pages on 2026-10-02 and supplied with task t1780u. The session that wrote this note made no request to Kraken and did not reopen the pages, so it did not check them against the live pages itself.

This note is not a C5 reading. C5 needs the owner's dated live-page reading of the pages decision section 4 lists, posted on pull request #3 ([M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md) section 1, C5). The requirements a reopened C5 would have are in [OWNER_GATE_STATUS.md](OWNER_GATE_STATUS.md). This note is not the owner's statement and is not posted on pull request #3. It does not meet, pass, or clear C5 or any other gate. For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED), and pursuing a Kraken adapter later reopens them.

## Sources

- Trade channel (WebSocket API v2): https://docs.kraken.com/api/docs/websocket-v2/trade
- Heartbeat channel (WebSocket API v2): https://docs.kraken.com/api/docs/websocket-v2/heartbeat
- Get Server Time (REST): https://docs.kraken.com/api/docs/rest-api/get-server-time
- Get Tradable Asset Pairs (REST): https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs

## Documented semantics

Each item below separates what a page says from what was tested live. Nothing was tested live.

### 1. `trade_id` (C5 item 1, `tradeIdOrdered: true`)

- Documented, on the trade page: "Trade identifier is a sequence number, unique per book."
- Paraphrase of that sentence (a paraphrase, not a live test): `trade_id` is documented as a per-book sequence identifier.
- Live test: none. How live `trade_id` values behave is not established here.

### 2. Batching (C5 item 2, `tradeStreamGranularity: per_fill`)

- Documented, on the trade page: "Multiple trades may be batched in a single message but that does not mean that these trades resulted from a single taker order."
- Documented, on the trade page, describing `data`: "A list of trade events."
- The page does not say the words "each event in data[] is separate". This note does not upgrade the two quoted sentences into that statement, or into a statement that each trade event is one fill. Whether each trade item is one fill is not established by these sentences.
- Live test: none.

### 3. Heartbeats (C5 item 3, the 15 s liveness timeout)

- Documented, on the heartbeat page: "Heartbeat messages are sent approximately once every second in the absence of any other channel updates."
- Paraphrase of that sentence (a paraphrase, not a live test): heartbeats arrive about once per second when no other channel updates occur.
- The quoted sentence states no idle-disconnect rule. This note cites no ping or status page, so it records no idle-disconnect rule.
- Live test: none.

### 4. REST metadata endpoints

- Get Server Time documents `GET /public/Time`: the server's `unixtime` and `rfc1123`. The published OpenAPI shows `security: []` on that GET.
- Get Tradable Asset Pairs documents `GET /public/AssetPairs`: tradable pair metadata. The published OpenAPI shows `security: []` on that GET.
- These pages document metadata endpoints. This note did not call them and did not read a live response.

## Live observation

A live 15-second observation was NOT performed. It is unnecessary for offline-only v1. v1 opens no connection to a venue, and the 15 s liveness timeout (contract sections 2 and 8.1) governs only a capture, which v1 does not run. Nothing in this note is a live-test result. Every statement above is documented semantics, taken from the quoted sentences or the cited pages.

## What this note does not do

- It is not the owner's dated live-page reading on pull request #3, and every C5 field in [OWNER_GATE_STATUS.md](OWNER_GATE_STATUS.md) stays blank.
- It does not read the other decision section 4 pages: terms and legal, US quick-start and licensing, fees, book, rate limits, instrument, and historical data.
- It records no legal permission, no jurisdiction, and no currency confirmation for C2 or C3.
- It changes neither the contract nor the decision document, the schemas, or the fixtures. It adds no venue payload, no sample trade, and no market data.
