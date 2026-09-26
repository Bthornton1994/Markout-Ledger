# Post-merge owner packet

This file is text for the owner. It does not contact a venue, counsel, or anyone else. It does not clear C2, C3, or C5. It does not name a commit of this remediation as cleared. The owner writes the live pull-request head SHA into the request below at the moment of pasting. A later push voids that request. Green CI is not an independent review.

This remediation is a documents change under handoff Gate and sequence step 3a. It is not the step-1 clearance of pull request #3. It does not start PR-0 or PR-1.

## BLOCKED owner gates

These stay unmet. This remediation does not meet any of them.

- **C2.** Four uses, each cleared separately and attested by the owner's nonprivileged attestation on pull request #3: automated first-party access to the public WebSocket API v2 and to the public REST endpoints the capture and P0 use (`AssetPairs`, `Time`); private retention of the raw captures on the owner's host; the research use of this project; and publication, in this public repository and its pull requests, of outputs derived from captured data other than the recorded data itself (for C2, cleared at least for the P0 statement and the A12 outputs). For the P0 listing, C2 also includes the owner's answer on whether retaining the P0 payload is covered. Model training on any capture, and publishing recorded data itself, stay further uses. This packet does not write that attestation.
- **C3.** The owner's written confirmation on pull request #3, from the live page and with the date of that reading, that the host that runs the P0 listing and every capture is located in, and the person who operates it resides in, a US state Kraken serves for spot. It is read on the day of the listing and again before each capture day. This packet does not name a host or an operator.
- **C5.** The owner's dated live-page reading of decision section 4, including the three items behind `tradeIdOrdered`, `per_fill`, and the 15 s liveness timeout. This packet does not record that reading.
- **P0 listing.** Only after C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing. The P0 listing does not wait for C5. This packet does not run a listing and does not contact the venue.
- **C1.** Precision: PR-0, independently QA'd at one exact SHA Z, or a substitute pair chosen from the P0 listing (then PR-0 is skipped and there is no Z). This packet does not implement PR-0 and does not choose a pair.
- **C4.** Fee re-read on the capture day (fee schedule, eligible-pairs list, and the other pages the decision and protocol name). This packet does not record a fee.

No capture runs until the cleared implementation SHA (Z when PR-0 is not skipped, Y for PR-1, and the cleared SHA of every step 3a change and every PR-1 follow-up the capture depends on) and C2, C3, C5, P0, C1 and C4 are satisfied.

## What this remediation changed, and what it did not

Fixed in the draft pull request, still subject to the owner's merge after an exact-SHA independent QA of that pull request:

- Recorded fixture event sizes must have `decimalsOf(header.qtyScale)` places (`$defs/fixtureLines` and the repository rule). A single line still accepts either width, because a line cannot see the header.
- A matched subscription response with `success` false settles on the next record: initial subscription as `subscribe_rejected` (which ends the capture); a resync unsubscribe or a non-initial subscribe as `resync_failed`. A later record on that socket or after that settlement is refused.
- The release-prep stop for a P0 listing is C2 or C3. The stop for capture remains C2, C3, or C5, and capture also waits for the cleared implementation SHA, P0, C1 and C4.
- The handoff sequence now requires PR-0, unless the owner skips it, to be independently QA'd at Z. The tenth revision note that said the sequence names no exact-SHA QA for PR-0 is kept as history and is superseded.

Not done, and not to be treated as done:

- No `src/` implementation. PR-0 and PR-1 have not started.
- No capture, no P0 listing, no venue or counsel contact, no credentials.
- No claim that C2, C3, or C5 is met.

## CI and the exact SHA

`.github/workflows/ci.yml` runs on `pull_request` and on a push to `main`. The history step sets `A10_HEAD` from `github.event.pull_request.head.sha` (the pull request head) or, on a push, from `github.sha`. The other steps run on the checkout `actions/checkout` makes. For a `pull_request` event that checkout is the merge ref, not the head SHA. When the base is an ancestor of the head, that merge tree is the head tree. A later commit on the base can make the merge tree differ from the head. Green CI on the merge ref is not a clearance of the head, and it is not an independent review.

## Independent QA request

Paste the block below into a fresh top-level session. Do not resume the session that wrote this remediation. Do not resume either authors' session of pull request #3 (`https://claude.ai/code/session_012vfVeZ81tBGEeg2YZGvWVE` and `https://claude.ai/code/session_01BUkiEi2VNHVrLjzKiAUG1Z`) or any session, subagent, or agent either created or ran, directly or through another session or agent. The reviewer is not the implementer of this remediation.

Before pasting, the owner reads the live head of the draft pull request and writes that full 40-character SHA in the blank. Do not paste a SHA from this file. This file does not contain the remediation head.

```
You are a read-only independent reviewer. Do not edit, commit, push, merge, or open a pull request. Do not contact a venue or counsel. Do not run a capture or a P0 listing. Do not claim that C2, C3, or C5 is met. Green CI is not this review.

SHA under review (owner fills this from the live pull-request head at paste time): <FULL 40-CHARACTER SHA>

Start by reading that SHA from the remote and confirming it is the live head of the draft pull request. Say so. If it is not, stop. Before you report, read the live head again. If it differs from the SHA above, the review is void: say so and give no verdict. Any push after this request voids the review. A clearance of another SHA, or of "the latest", does not count.

Scope: the post-merge remediation branched from 9d89f9f2ba785856e0753c4ed2857a2c26b2394f. Check, at that exact SHA:

1. A recorded fixture with qtyScale 100000000 rejects six-place event sizes, and qtyScale 1000000 rejects eight-place event sizes. Schema validation, A10 classification, examples, and tests agree. A single line may still accept either width.
2. A matched initial subscription response with success false settles immediately as subscribe_rejected, and the capture accepts no later record. A failed resync acknowledgement settles as resync_failed, and no later record of that socket is accepted after settlement. Removing either rule fails the new tests.
3. docs/RELEASE_PREP.md does not make a P0 listing wait for C5. Capture still waits for C2, C3, and C5, and also for the cleared implementation SHA, P0, C1, and C4.
4. The handoff sequence is unambiguous: pull request #3 is merged; PR-0, unless skipped, is implemented and independently QA'd at one exact SHA Z; PR-1 is implemented and independently QA'd at one exact SHA Y; a later documents or reference-vector correction needs its own exact-SHA QA; no capture until that implementation SHA and C2, C3, C5, P0, C1, and C4. This review is not the step-1 clearance of pull request #3, and it does not clear Z or Y.
5. No file in the diff is under src/, and none contains credentials, a capture, or raw venue data. Fail-closed rules are not weakened.

Report PASS or FAIL per item, with file and line or command evidence. Do not merge.
```

## Offline deployment note

[DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md) records deployment and rollback requirements. The target fields there are blank. This note does not meet a blocked gate above. The assertion fields below stay blank.

| Gate | Owner fills |
| --- | --- |
| C2 | ________ |
| C3 | ________ |
| C5 | ________ |
