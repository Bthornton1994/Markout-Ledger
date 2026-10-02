# Owner gate status

This file is the v1 gate status for C2, C3, and C5. It records each of them as OUT OF SCOPE FOR V1, not PASSED, not MET. It supplies no evidence for any of them. It is not an attestation, it does not clear any gate, and it does not contact a venue, counsel, or anyone else.

C2, C3, and C5 are OUT OF SCOPE FOR V1 (not PASSED). Markout Ledger v1 is an offline evaluation product: the v1 product path is offline evaluation on synthetic fixtures and data with documented rights for the intended use only. The fixtures this repository ships are all synthetic. The engine does not check rights, so whoever supplies other data documents its rights for the intended use. v1 is not Kraken-connected and not capture-ready, and it runs no P0 listing and no capture. There is no Kraken adapter on the default path, and none exists under `src/`: `src/market/kraken-adapter.ts` is only a disabled placeholder (`KRAKEN_ADAPTER_ENABLED` is `false` and its one function throws), it holds no network code, and nothing on the default path imports it. Pursuing a Kraken adapter later reopens C2, C3, and C5.

Definitions stay in [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md) section 1 (C2, C3, C5) and section 4 (the readings behind C5), and this file changes none of them. The owner asks mirror [POST_MERGE_OWNER_PACKET.md](POST_MERGE_OWNER_PACKET.md). Where this file and the decision document differ on what a gate requires, the decision document governs.

Supporting records: [C5_RESEARCH_NOTE_2026-10-02.md](C5_RESEARCH_NOTE_2026-10-02.md) is a dated note on what four Kraken documentation pages say; it is not a live-page reading and does not meet C5. [audit/t1780u-offline-v1/](audit/t1780u-offline-v1/) holds the assumptions behind this scope.

Context only: this file was written against `main` at `c408f79f9ed154191b065d1dafcd9d87c5bed62c`. That SHA is not a clearance and not a release tip. [RELEASE_PREP.md](RELEASE_PREP.md) still records the pull request #6 merge as its tip, and this file does not change that record. The v1 scope was recorded on 2026-10-02 (task t1780u) against `main` at `ac34e3771158985fef0c9062fce064c5539ef6da`, which is not a clearance or a release tip either.

## Status

| Gate | Status | Owner fills |
| --- | --- | --- |
| C2 | OUT_OF_SCOPE | ________ |
| C3 | OUT_OF_SCOPE | ________ |
| C5 | OUT_OF_SCOPE | ________ |

`OUT_OF_SCOPE` means OUT OF SCOPE FOR V1, not PASSED, not MET, and not cleared. v1 asks the owner for nothing under these gates, and every owner cell stays blank.

If the Kraken path is reopened, the owner posts a nonprivileged attestation on pull request #3 (`https://github.com/Bthornton1994/Markout-Ledger/pull/3`). The owner keeps the underlying record (Kraken's written reply, or counsel's opinion) and does not post it. Nothing privileged is posted, subject to counsel's advice about what may be disclosed. Filling a blank in this file is a later owner change; the committed copy keeps every blank.

## Reopened-gate requirements (not v1 work)

The three sections below say what C2, C3, and C5 would require if a Kraken adapter is pursued later and the gates reopen. They are reopened-gate requirements, not v1 work: v1 asks for none of this evidence, and this file supplies none of it.

## C2, rights and terms (reopened-gate requirements)

On a reopened Kraken path, C2 stays unmet until every one of the four uses below is cleared separately under route (a) or route (b) and the owner's nonprivileged attestation covering each is posted on pull request #3.

The four uses (decision section 1, C2):

- (i) automated first-party access to the public WebSocket API v2 and to the public REST endpoints the capture and P0 use (`AssetPairs`, `Time`);
- (ii) private retention of the raw captures on the owner's host;
- (iii) the research use of this project;
- (iv) publication, in this public repository and its pull requests, of outputs derived from captured data other than the recorded data itself; for C2 the clearance must name at least the outputs P0 and A12 publish (the P0 derived statement, the raw files' and the fixture's hashes, the normalize report and the values A12 reports). Every other derived output, later evaluation reports and grids included, waits for a further attested clearance naming it.

The two routes are defined in decision section 1, C2, and only as written there. In short, route (a) is Kraken's written permission for the use, or Kraken's written clarification concluding that it is permitted, and route (b) is a lawyer's written opinion on the terms under the full test that section 1, C2 states, with that section's limits on what a lawyer can clear. Neither is restated here as a substitute for that text.

Evidence the owner supplies for C2, on pull request #3:

1. For each of uses (i) to (iv): the record's date; its source (Kraken, or counsel acting for the owner); the terms and uses it addresses; and its outcome for that use. A record that is silent on a use, or concludes against it, does not clear it.
2. The P0 payload retention answer: whether retaining the P0 listing's venue payload on the owner's host is covered by a clearance. Use (ii) names only the raw captures. For the P0 listing this answer is part of C2, and the P0 listing does not run until it is posted.
3. Currency: before the P0 listing, and again before each capture day, a dated confirmation that the terms and uses the attested clearance relied on are unchanged as read that day. A changed term leaves C2 UNMET for the affected use until it is cleared again and attested.

Model training on any capture, and publishing recorded data itself, are further uses. Each stays excluded unless it is itself cleared, expressly and by name, under the same routes and test.

| C2 field | Owner fills |
| --- | --- |
| Use (i) record date, source, outcome | ________ |
| Use (ii) record date, source, outcome | ________ |
| Use (iii) record date, source, outcome | ________ |
| Use (iv) record date, source, outcome, outputs named | ________ |
| P0 payload retention answer | ________ |
| Currency confirmation date before the P0 listing | ________ |
| Pull request #3 attestation comment | ________ |

## C3, jurisdiction (reopened-gate requirements)

On a reopened Kraken path, C3 stays unmet until the owner confirms in writing on pull request #3, from the live page and with the date of that reading, that the host that runs the P0 listing and every capture is located in, and the person who operates it resides in, a US state Kraken serves for spot. The page is `https://support.kraken.com/articles/quick-start-for-clients-in-the-united-states`.

Evidence the owner supplies for C3, on pull request #3:

1. The date the owner read the live quick-start page.
2. Host located in a served US state: yes or no.
3. Operator resides in a served US state: yes or no.
4. For the P0 listing, a reading made on the day of the listing. For each capture day, a re-confirmation from that day's reading, before that day's capture.

The state need not be named publicly and may stay private. No geographic workaround of any kind: no VPN, proxy, remote host, or third party in another jurisdiction.

| C3 field | Owner fills |
| --- | --- |
| Live quick-start page read date | ________ |
| Host in a served US state (Y/N) | ________ |
| Operator resides in a served US state (Y/N) | ________ |
| Pull request #3 confirmation comment | ________ |

## C5, pre-capture reading (reopened-gate requirements)

On a reopened Kraken path, C5 stays unmet until the owner has read every item of decision section 4 on the live page and recorded its date, and has posted on pull request #3 a dated statement of the live-page reading and its outcome (the page confirms the contract's assumption, contradicts it, or does not address it) for each of these three:

1. `tradeIdOrdered: true`, with its `tradeIdRegression` drop (contract section 5.7): the trade page's wording on `trade_id` as a sequence number unique per book.
2. `tradeStreamGranularity: per_fill` (contract section 5.4): whether each trade item is one fill.
3. The 15 s liveness timeout (contract sections 2 and 8.1): the heartbeat cadence and any idle-disconnect rule on the heartbeat, ping and status pages.

The remaining section 4 readings (terms and legal pages, the US quick-start and licensing pages, the fee pages, the book pages, the rate-limit pages, the instrument and `AssetPairs` pages, and the historical-data pages) each need a live-page reading with its date before the first capture.

An outcome other than "confirms" for any of the three keeps C5 UNMET until either the contract is corrected in a documents change under handoff Gate and sequence step 3a with its own exact-SHA independent QA, or the owner records on pull request #3 a decision to capture on the stated assumption. This file makes that decision for no one.

No capture starts while C2, C3, or C5 is UNMET. The P0 listing does not wait for C5.

The 2026-10-02 research note is not this reading: it is not the owner's live-page reading, it is not posted on pull request #3, and every C5 field below stays blank.

| C5 field | Owner fills |
| --- | --- |
| `tradeIdOrdered` reading date and outcome | ________ |
| `per_fill` reading date and outcome | ________ |
| 15 s liveness reading date and outcome | ________ |
| Remaining section 4 readings recorded with dates | ________ |
| Pull request #3 statement comment | ________ |

## Non-claims

| Claim | Status in this repository |
| --- | --- |
| C2 | OUT OF SCOPE FOR V1; not PASSED, not MET. No attestation is recorded here. |
| C3 | OUT OF SCOPE FOR V1; not PASSED, not MET. No host, operator, or state is named here. |
| C5 | OUT OF SCOPE FOR V1; not PASSED, not MET. No live-page reading is recorded here. |
| P0 listing | Not authorized, and out of scope for v1. On a reopened Kraken path it waits for C2 and C3 (see [OWNER_P0_READINESS.md](OWNER_P0_READINESS.md)). |
| Capture | Not authorized, and out of scope for v1. On a reopened Kraken path it waits for C2, C3, and C5, and for the cleared implementation SHA, P0, C1, and C4. |
| Kraken adapter | None on the default path, and none under `src/` beyond the disabled placeholder `src/market/kraken-adapter.ts`. |
| Live observation | None. No live-page reading and no live 15 s observation was made for v1. |
| Deploy target | None. [DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md) keeps every target field blank. |
| Venue or counsel contact | None made by this repository or its agents. |

## Offline check

`node scripts/gate-status-check.mjs` reads this file, [OWNER_P0_READINESS.md](OWNER_P0_READINESS.md), [POST_MERGE_OWNER_PACKET.md](POST_MERGE_OWNER_PACKET.md) and [DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md). It exits 0 only while the three status rows above are exactly `OUT_OF_SCOPE` with blank owner cells, every other C2, C3 and C5 fill field is still blank, and these files still carry their v1 sentences; it then prints the v1 status and the reopened-gate requirements. It exits 1 otherwise, including when a C2, C3 or C5 row says MET, PASS, PASSED or UNMET. `tests/gate-status-blanks.test.ts` runs it under `npm test`. `tests/v1-offline-boundary.test.ts` checks that the default path never reaches the disabled adapter and that no file under `src/` holds network code. A passing check means the v1 status and the blanks are intact. It is not a clearance of anything.
