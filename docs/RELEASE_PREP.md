# Release prep

This file records `main` after pull request #3. It describes the offline path that exists today. It does not choose a deploy target, does not deploy, and does not state that the core function is production-ready.

C2, C3, and C5 remain unmet. This file is not an attestation of any of them. Definitions stay in [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). This file does not restate those definitions and does not record that any of them has been met.

## 1. Post-merge verify

Read from git on `main`, and from the GitHub Actions run for that push.

| Item | Value |
| --- | --- |
| `main` tip | `890637815bb7370f75695dc20906eb12e9e289f6` |
| Subject | Merge PR #3: Milestone 2 data contract (exact-SHA QA PASS) |
| Commit time | 2026-09-25 20:29:52 -0700 |
| Sole parent | `4beacde9f8ecf2072936a7ab3ee790db2f3e614a` |
| Tree | `6e732026540dce5912aa6b715b23b7c15a9654ed` |
| Pull request #3 | https://github.com/Bthornton1994/Markout-Ledger/pull/3 |
| Pull request #3 tip | `8d68381766cb9d7645a6ed7d4f700a910ccfcccc` |
| Pull request #3 tree | `6e732026540dce5912aa6b715b23b7c15a9654ed` (the same tree as `main`) |

The `main` commit has one parent. The pull request #3 tip is not a git ancestor of `main`. The two commits have the same tree.

CI for that push:

| Item | Value |
| --- | --- |
| Workflow | `ci` (`.github/workflows/ci.yml`) |
| Event | `push` to `main` |
| Run | https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36214977668 |
| Head SHA | `890637815bb7370f75695dc20906eb12e9e289f6` |
| Job | `check` |
| Conclusion | `success` |
| Completed | 2026-09-26T03:30:42Z, which is 2026-09-25 20:30:42 Pacific Time (PDT, UTC-7) |

That `success` is the offline `check` job on the merge commit. It is not an attestation of C2, C3, or C5.

## 2. Current path

The only workflow in the repository is `.github/workflows/ci.yml`. It has no deploy job. No other workflow file is present, and the repository names no deploy target.

The current path is that CI job plus an offline Node replay. The `check` job runs, in order:

1. `npm ci`
2. `npm run test:history` (the A10 history scan the workflow already runs)
3. `npm run test:schemas`
4. `npm run typecheck`
5. `npm test`
6. `npm run demo`, which writes `out/`
7. upload of `out/` as the artifact named `replay-output`

The same Node commands are the local replay path. `npm run demo` writes `out/<scenario>/`. Nothing in this path deploys.

## 3. Rollback

No production rollback procedure is documented. The sole git parent of the `main` tip is `4beacde9f8ecf2072936a7ab3ee790db2f3e614a` (Merge PR #2: Milestone 1 deterministic replay and decision ledger). That parent is history. This file does not define a rollback.

## 4. Owner decisions still required

These decisions are still open. This file does not make them.

- **Deploy and target.** Required before a deploy target is chosen and before any deploy. No deploy workflow and no deploy target exist in the repository today.
- **P0 listing.** C2 and C3 are still required before a P0 listing, as the decision document already states. This file does not supply those attestations.
- **Capture.** C5 is still required before capture, together with C2 and C3, as the decision document already states. This file does not supply that reading.

## 5. Stop conditions

While C2, C3, or C5 is unmet:

- Do not capture.
- Do not run a P0 listing.
- Do not make venue or data-use claims.

This is the release-prep halt. It does not amend [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). That document already says the P0 listing does not run until C2 and C3 are met, that the P0 listing does not depend on C5, and that nothing is captured until C2, C3, and C5 are met. The provisional venue text already in the Milestone 2 documents is not repeated here as a clearance.
