# Owner P0 readiness (owner only)

**NOT AUTHORIZED TO RUN.** The P0 listing is NOT AUTHORIZED until C2 and C3 are attested by the owner on pull request #3, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing. For P0, C2 includes the owner's answer on whether retaining the P0 payload is covered. C2 and C3 are UNMET today ([OWNER_GATE_STATUS.md](OWNER_GATE_STATUS.md)).

Only the owner runs P0. The chief of staff, the implementer, and every agent, subagent or automated session never run P0, never contact the venue, and never receive the venue payload.

This checklist was prepared offline. It runs nothing, contacts nothing, and fills no gate. The procedure is handoff section 0, "P0, before any code" ([M2_GROK_HANDOFF.md](M2_GROK_HANDOFF.md)), which governs where this file differs.

## Preconditions (owner fills on the day of the listing)

| Precondition | Owner fills |
| --- | --- |
| C2 attestation on pull request #3, all four uses | ________ |
| C2 P0 payload retention answer on pull request #3 | ________ |
| C2 currency confirmation date before the listing | ________ |
| C3 live-page reading date (the day of the listing) | ________ |
| C3 host and operator confirmation on pull request #3 | ________ |

If any row above is blank, stop. Do not run P0.

## Steps after the gates (owner only)

1. Use the host confirmed under C3, operated by the person confirmed under C3. No VPN, proxy, remote host, or third party in another jurisdiction.
2. Take one public instrument snapshot, either `{"method":"subscribe","params":{"channel":"instrument","snapshot":true}}` on `wss://ws.kraken.com/v2`, or `GET https://api.kraken.com/0/public/AssetPairs`. Reference data only; no market data is captured.
3. From that snapshot, list every pair with `qty_precision <= 6` and `price_precision <= 6` (REST: `lot_decimals <= 6` and `pair_decimals <= 6`), with `status`. Record `BTC/USD`'s values.
4. Keep the venue payload only as the P0 payload retention answer allows. Never commit it, never paste it into a pull request, an issue or a chat, and never hand it to the implementer or an agent.
5. Post on pull request #3 only the owner's own derived statement: pair names as the endpoint used gives them, precisions, increments, status, and the date. This is a C2 use (iv) output, posted only as far as its attested clearance covers it. Add the choice between PR-0 and a substitute pair.
6. If the owner substitutes a pair, PR-0 is skipped, and the symbol changes in the handoff and contract section 8 through a documents change under handoff Gate and sequence step 3a with its own exact-SHA QA. The capture-day fee re-read of C4 then follows the substitute.

| P0 record | Owner fills |
| --- | --- |
| Listing date | ________ |
| Endpoint used (WebSocket or REST) | ________ |
| Pull request #3 derived-statement comment | ________ |
| Choice: PR-0 or substitute pair | ________ |

## C5 and capture

C5 is not required for P0. C5 is required before any capture: nothing is captured until C2, C3, and C5 are met, and capture also waits for the cleared implementation SHA, P0, C1, and C4. P0 is not a capture and does not authorize one.
