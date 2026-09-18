# Milestone 2 data-source decision

Date checked for every source below: **2026-09-18**. How sources were checked is stated per item, because this evaluation was done from an environment whose egress policy blocks every venue website: official documentation that venues publish in public GitHub repositories was read at a pinned commit (**[R]**), everything else (terms pages, pricing, historical archives, geographic restrictions) is known only through search-tool excerpts (**[S]**) and must be re-read on the live page by the owner before capture begins. Nothing marked [S] is treated as verified.

## 1. Decision

**Selected: Bybit spot `BTCUSDT`, captured first party from the public WebSocket (`orderbook.50.BTCUSDT` at 20 ms with in-band snapshots, `publicTrade.BTCUSDT` real time), with `orderbook.full.BTCUSDT` (200 ms, documented gap rule) as the adapter's documented fallback stream.** Adapter mapping: M2_DATA_CONTRACT.md §8.

Why this one:

- Book deltas every 20 ms with a matching-engine timestamp (`cts`) that the venue documents as correlatable with the trade fill time (`T`), so `marketTime` for books and trades is on one venue clock [R].
- Trades carry an explicit taker side (`S`), a trade id (`i`) and a fill time (`T`) [R]; nothing has to be inferred from a maker flag.
- Spot semantics match the engine's accounting (no funding, no mark price); BTCUSDT's `basePrecision` is `0.000001` and `tickSize` `0.1`, inside the engine's six-decimal fixed point [R].
- Free, no API key, no account for anything the capture needs [R].
- Every field mapping and the synchronization rules were read from the venue's official documentation repository at a pinned commit [R], so the adapter can be implemented without access to the website.

Conditions attached to the decision:

- **Publication: hash only.** The search-visible terms say API/Service Data may not be repackaged, resold or further distributed without written consent [S]. No captured Bybit data is committed to this repository; the repository carries hashes, manifests and normalize reports. The `rights` block of every Bybit fixture is `redistribution: "prohibited"`, `publication: "hash_only"` until the owner obtains written consent.
- **Jurisdiction.** Bybit excludes the United States and other jurisdictions [S]. The capture host and its operator must be eligible; if they are not, the alternate below does not help (Binance has the same exclusion [S]) and the decision moves to a US-accessible venue (Coinbase Exchange or Kraken), whose documentation could not be verified from this environment (§4).
- **Owner pre-capture checklist.** Read the live API Terms and Terms of Service and the restricted-countries page, record the URLs and the date in the `rights` block, confirm the fee schedule for spot at capture time, and confirm eligibility of the capture host.

**Alternate on the same contract: Binance spot `BTCUSDT`** via the market-data-only hosts (`data-stream.binance.vision`, `data-api.binance.vision`) [R]: 100 ms diff-depth batches with a fully documented snapshot and gap procedure (`U`/`u` against `lastUpdateId`) [R]; aggressor from the maker flag `m` [R]; same restrictions on publication and jurisdiction [S]. Mapping in contract §8, appendix.

**Research target, deferred: Kuru `MON-USDC` on Monad** (the venue the inspiration project trades). Its data path is sound for provenance (every book change is an on-chain event with block number and log index; fills name maker and taker) [R], but block timestamps have one-second granularity [S] and the engine decides eligibility on millisecond venue time, so it needs a versioned engine change (block-ordinal eligibility) before it can be a replay source; see §3.

## 2. Selected feed: what was established

| item | finding | how checked |
|---|---|---|
| access cost | Free. Public topics need no authentication; public REST market endpoints need no key. Limits: 600 REST requests per 5 s per IP; do not open more than 500 WebSocket connections in 5 minutes; heartbeat `{"op":"ping"}` recommended every 20 s; idle connections cut after 10 minutes without traffic | [R] `docs/v5/websocket/wss-authentication.mdx`, `docs/v5/rate-limit/rate-limit.mdx` |
| book depth and updates | `orderbook.{1,50,200,1000}.{symbol}` at 10/20/100/200 ms; an in-band `snapshot` on subscribe, then `delta` messages "every time the orderbook changes"; a new `snapshot` (or `u = 1`) means reset; delta size `0` deletes a level; RPI orders are never included. `orderbook.full.{symbol}`: delta-only at 200 ms, initialized from `GET /v5/market/full_orderbook` (up to 10,000 levels per side), `u` documented as consecutive (`u+1`), `seq` monotone but not consecutive | [R] `docs/v5/websocket/public/orderbook.mdx`, `full-ob.mdx`, `docs/v5/market/orderbook.mdx` |
| trades | `publicTrade.{symbol}`, real time; per element `T` (ms fill time), `S` taker side `Buy`/`Sell`, `v`, `p`, `i` trade id, `BT` block trade, `RPI` retail-price-improvement trade, `seq`; up to 1024 trades per message, "multiple messages may be sent for the same `seq`" | [R] `docs/v5/websocket/public/trade.mdx` |
| venue timestamps | Book: `ts` (system generation) and `cts` ("from the matching engine when this orderbook data is produced. It can be correlated with `T` from public trade channel"); trades: `T`. All milliseconds. `GET /v5/market/time` gives `timeNano` for offset probes | [R] same files; `docs/v5/market/time.mdx` |
| sequence and gap detection | `u` (update id) on every book message and on the REST snapshot ("is always in sequence"); `seq` cross sequence. Contiguity `u+1` and the missed-event rule ("If the event's `u` is greater than the local order book's `u` + 1, one or more events have been missed ... Discard the local order book. Restart") are documented for `orderbook.full`; for `orderbook.50` the documentation states resets only. The adapter applies the `u+1` rule to `orderbook.50` and fails closed on any jump; the first capture reports the jump count, and a non-zero count moves the adapter to `orderbook.full` | [R] `full-ob.mdx`, `orderbook.mdx`, `market/orderbook.mdx` |
| receive timestamps | None from the venue on any stream, endpoint or archive. `obsTime` is our capture's receive clock (contract §1) | [R] absence in all files read; [S] archives |
| historical availability | Official archives exist for trades (`public.bybit.com`) and, per community descriptions, order-book snapshot/delta files at 200 and 500 levels (`quote-saver.bycsi.com`); they carry venue time only and are **not** causal replay data. Usable only to cross-check a first-party capture (trade ids, prices) | [R] pointer in `docs/v5/market/recent-trade.mdx`; [S] everything else |
| storing captures | Not expressly granted; the located clauses forbid repackaging, reselling and further distribution, not retention for own use. Treated as: private storage for research, never published | [S] API Terms, Terms of Service |
| publishing samples in this repository | **No** without written consent | [S] |
| fee schedule for the recorded scenario | Spot 0.1% maker and 0.1% taker for non-VIP accounts [S]; the recorded scenario uses `makerFeeBps = 10`, `placementCost = cancelCost = 0`, and the sensitivity grid sweeps fees (M2_EVALUATION_PROTOCOL.md §2). The authenticated fee-rate endpoint is out of scope | [S] fee page; [R] `docs/v5/account/fee-rate.mdx` exists but needs auth |
| instrument specification | `GET /v5/market/instruments-info?category=spot&symbol=BTCUSDT`: `priceFilter.tickSize` (`"0.1"` in the documented example), `lotSizeFilter.basePrecision` (`"0.000001"`). Fetched verbatim into the capture manifest at capture start | [R] `docs/v5/market/instrument.mdx` |

## 3. Candidates compared

| candidate | book | trades and aggressor | venue time | sequence / gap detection | receive time | historical | cost | store / publish | verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Bybit spot BTCUSDT** | 50 levels at 20 ms with in-band snapshots; full book at 200 ms [R] | per trade, explicit taker side [R] | ms; matching-engine `cts` [R] | `u` (+1 documented for full stream) [R] | none; first-party capture | trades and book archives, venue time only [S] | free [R] | private / no [S] | **selected** |
| Binance spot BTCUSDT | full-depth diffs in 100 ms batches; snapshot up to 5000 levels [R] | per trade, maker flag `m` [R] | ms (µs opt-in); depth carries event time `E`, not match time [R] | `U`/`u` vs `lastUpdateId`, documented gap rule [R] | none; first-party capture | trades/aggTrades/klines only, no spot depth, venue time only [R] | free, market-data-only hosts [R] | private / no [S]; US blocked with HTTP 451 [S] | alternate |
| Hyperliquid (perp, e.g. BTC) | public `l2Book` is a stream of complete 20-level aggregated snapshots with no sequence number or diff [R SDK types and recorded response]; cadence reported as 2 s (5-level `fast` variant about 0.5 s) since a June 2026 change [S] | `trades` with side `A`/`B`, `tid`, `users` [R SDK, S] | ms block `time` shared by all events of a block [S] | none on the public stream; full per-block book diffs only from a self-hosted node (16 vCPU, 128 GB) [R node README] | none; first-party capture | S3 archive of L2 snapshots, requester-pays, venue time only [S] | free API; node hosting cost | no redistribution clause located in Hyperliquid's own terms; US and Ontario persons are Restricted Persons; trades expose counterparty addresses [S] | not selected: sampled book without gap detection; perp accounting |
| Kuru MON-USDC on Monad | full L3 from contract events (`OrderCreated`, `OrdersCanceled`, `Trade`), `getL2Book()` view; vault liquidity mixed into the L2 [R kuru-sdk ABI and source] | `Trade` event names maker and taker, fill size and price [R] | block timestamp, 1 s granularity with ~400 ms blocks [S] | block number + log index; gaps = missing blocks | none; first-party capture via own RPC/node | full history on chain, no receive time | RPC provider tier or own node | public-chain data: yes, subject to provider terms [S] | research target after an engine change |
| Coinbase Advanced Trade / Exchange BTC-USD | level2 with `sequence_num` per message [S] | `market_trades` with side [S] | ms [S] | `sequence_num` [S] | none | none official [S] | free [S] | market-data terms not readable here [S] | fallback if jurisdiction excludes Bybit/Binance; unverified |
| Third-party recorded (Tardis.dev) | vendor-normalized, exchange-native messages with `localTimestamp` [R tardis-node README] | as recorded | as recorded | as recorded | vendor's collectors, not ours | yes, paid; free tier limited [S] | paid | redistribution not permitted [S] | not for M2; possible cross-check |

## 4. What could not be verified from this environment

- The live text of any venue's terms of use, restricted-countries page, fee page or historical-archive page (all blocked by the egress policy; search excerpts only).
- Coinbase and Kraken documentation (no official GitHub mirror of their API references was found).
- Whether Bybit's `orderbook.50` `u` is contiguous in practice (documented only for `orderbook.full`); the first capture answers this.

These are owner actions before capture, not blockers for the build: the build's tests run on generated raw captures in the venue's documented message format, and the real-session evidence (handoff A12) is produced from a host the owner controls.

## 5. Citation ledger

Official documentation repositories, cloned and pinned:

| repository | commit | files read |
|---|---|---|
| `bybit-exchange/docs` (source of bybit-exchange.github.io/docs) | `75994fda16e0` | `docs/v5/websocket/public/orderbook.mdx`, `full-ob.mdx`, `trade.mdx`, `docs/v5/websocket/wss-authentication.mdx`, `docs/v5/market/orderbook.mdx`, `full-ob.mdx`, `instrument.mdx`, `time.mdx`, `recent-trade.mdx`, `docs/v5/rate-limit/rate-limit.mdx`, `docs/v5/account/fee-rate.mdx`, `docs/changelog/v5.mdx` |
| `binance/binance-spot-api-docs` | `828ca74b809c` | `web-socket-streams.md` (Diff. Depth Stream, Trade Streams, How to manage a local order book correctly, WebSocket limits), `rest-api.md` (Order book), `faqs/market_data_only.md`, `PROD-TERMS-OF-USE.md` (a pointer to binance.com/en/terms), `filters.md`, `sbe-market-data-streams.md`, `CHANGELOG.md` |
| `binance/binance-public-data` | `5c7f3197591c` | `README.md` (spot: aggTrades, trades, klines; no depth) |
| `hyperliquid-dex/hyperliquid-python-sdk` | `2fdb18f95176` | `hyperliquid/info.py`, `hyperliquid/websocket_manager.py` (`l2Book`, `trades` subscriptions) |
| `hyperliquid-dex/node` | `405cc08b17a7` | `README.md` (`--write-trades`, `--write-order-statuses`, `--write-raw-book-diffs`) |
| `Kuru-Labs/kuru-sdk` | `636509c2eafd` | `abi/OrderBook.json` (events `OrderCreated`, `OrdersCanceled`, `Trade`; views `getL2Book`, `getMarketParams`, `s_orders`), `src/types/types.ts`, `src/market/orderBook.ts`, `src/listener/orderbookListener.ts` |
| `tardis-dev/tardis-node` | `8c3cfe715fd0` | `README.md` (`localTimestamp`), `src/mappers/binance.ts`, `src/consts.ts` |
| `jarrodwatts/jev-trader` (inspiration only, no code reused) | `main` | `README.md`: one decision per Monad block on Kuru MON-USDC; order book via `eth_call`, blocks via `newHeads` |

Search-derived items [S] and the URL the owner must read: Bybit API Terms (`bybit.com/en/legal/service-specific-terms/API-Terms`: "shall not ... repackage or resell the services, or any part thereof, API or Service Data"), Bybit Terms of Service (`bybit.com/en/legal/terms-of-service`: "any Material provided was provided for the user only and is not to be further distributed without the written consent of the Company"), Bybit restricted countries (`bybit.com/en/help-center/article/Service-Restricted-Countries`), Bybit fee page; Binance Terms of Use (`binance.com/en/terms`, intellectual-property and Restricted Location clauses) and API product guidance; Hyperliquid Terms (`app.hyperliquid.xyz/terms`: Restricted Persons include the United States and Ontario; section 3.1.8 limits automated use; no market-data redistribution clause was located, and a "may not redistribute content" sentence that search surfaced belongs to a third-party front end's terms, not Hyperliquid's), the Hyperliquid historical-data and rate-limit pages; Monad documentation (`docs.monad.xyz`: one-second `TIMESTAMP` granularity, ~400 ms blocks); Tardis.dev billing and data pages.
