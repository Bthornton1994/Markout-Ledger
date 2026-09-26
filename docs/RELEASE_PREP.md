# Release prep

This file records `main` through the pull request #5 merge `758defc624412666d4dea33bf76a705b6a0f7c52`. It describes the offline path that exists today. It does not choose a deploy target, does not deploy, and does not state that the core function is production-ready.

Production deployment requirements and rollback requirements, with every target field left blank, are in [DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md). That file names no deploy host and does not define an executable production rollback.

C2, C3, and C5 remain unmet. This file is not an attestation of any of them. Definitions stay in [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). This file does not restate those definitions and does not record that any of them has been met.

## 1. Recorded commits

Read from git, and from the GitHub Actions run for each push named below. A SHA that these tables do not name has no CI conclusion in this file. A commit after the pull request #5 merge is not described here.

### Pull request #3 merge

| Item | Value |
| --- | --- |
| `main` commit | `890637815bb7370f75695dc20906eb12e9e289f6` |
| Subject | Merge PR #3: Milestone 2 data contract (exact-SHA QA PASS) |
| Commit time | 2026-09-25 20:29:52 -0700 |
| Sole parent | `4beacde9f8ecf2072936a7ab3ee790db2f3e614a` |
| Tree | `6e732026540dce5912aa6b715b23b7c15a9654ed` |
| Pull request #3 | https://github.com/Bthornton1994/Markout-Ledger/pull/3 |
| Pull request #3 tip | `8d68381766cb9d7645a6ed7d4f700a910ccfcccc` |
| Pull request #3 tree | `6e732026540dce5912aa6b715b23b7c15a9654ed` (the same tree as that merge) |

That merge commit has one parent. The pull request #3 tip is not a git ancestor of that merge commit. The two commits have the same tree.

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

That `success` is the offline `check` job on that merge commit. It is not an attestation of C2, C3, or C5.

### Pull request #4

| Item | Value |
| --- | --- |
| `main` commit | `9d89f9f2ba785856e0753c4ed2857a2c26b2394f` |
| Subject | docs: offline release-prep runbook (#4) |
| Commit time | 2026-09-25 20:45:24 -0700 |
| Sole parent | `890637815bb7370f75695dc20906eb12e9e289f6` |
| Tree | `857cd9407756ca82eead5a9ce3c344fe249ad954` |
| Pull request #4 | https://github.com/Bthornton1994/Markout-Ledger/pull/4 |

CI for that push:

| Item | Value |
| --- | --- |
| Workflow | `ci` (`.github/workflows/ci.yml`) |
| Event | `push` to `main` |
| Run | https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36215785277 |
| Head SHA | `9d89f9f2ba785856e0753c4ed2857a2c26b2394f` |
| Job | `check` |
| Conclusion | `success` |
| Completed | 2026-09-26T03:46:20Z, which is 2026-09-25 20:46:20 Pacific Time (PDT, UTC-7) |

That `success` is the offline `check` job on that commit. It is not an attestation of C2, C3, or C5.

### Pull request #5 merge (recorded tip)

| Item | Value |
| --- | --- |
| `main` tip recorded here | `758defc624412666d4dea33bf76a705b6a0f7c52` |
| Subject | Post-merge: qtyScale event sizes and failed-subscription settlement (#5) |
| Commit time | 2026-09-26 12:37:25 -0700 |
| Sole parent | `9d89f9f2ba785856e0753c4ed2857a2c26b2394f` |
| Tree | `e4bfaa5511c2cfec8686d97e592313f7c757d15f` |
| Pull request #5 | https://github.com/Bthornton1994/Markout-Ledger/pull/5 |

CI for that push:

| Item | Value |
| --- | --- |
| Workflow | `ci` (`.github/workflows/ci.yml`) |
| Event | `push` to `main` |
| Run | https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36266694661 |
| Head SHA | `758defc624412666d4dea33bf76a705b6a0f7c52` |
| Job | `check` |
| Conclusion | `success` |
| Completed | 2026-09-26T19:38:08Z, which is 2026-09-26 12:38:08 Pacific Time (PDT, UTC-7) |

That `success` is the offline `check` job on that commit. It is not an attestation of C2, C3, or C5.

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

No executable production rollback is defined. [DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md) lists the decisions the owner fills before a deploy target is chosen and before a rollback procedure can exist. Every target field in that file is blank.

Git parents of the commits in section 1, each with one parent:

- Pull request #3 merge `890637815bb7370f75695dc20906eb12e9e289f6`, sole parent `4beacde9f8ecf2072936a7ab3ee790db2f3e614a` (Merge PR #2: Milestone 1 deterministic replay and decision ledger).
- Pull request #4 `9d89f9f2ba785856e0753c4ed2857a2c26b2394f`, sole parent the pull request #3 merge.
- Pull request #5 merge `758defc624412666d4dea33bf76a705b6a0f7c52`, sole parent the pull request #4 commit.

Those parents are history of those commits. They are not a production rollback target.

## 4. Owner decisions still required

These decisions are still open. This file does not make them.

- **Deploy and target.** Required before a deploy target is chosen and before any deploy. No deploy workflow and no deploy target exist in the repository today. The blank requirements are in [DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md).
- **P0 listing.** C2 and C3 are still required before a P0 listing, as the decision document already states. This file does not supply those attestations.
- **Capture.** Nothing is captured until the cleared implementation SHA (PR-0 at Z unless the owner skips PR-0, PR-1 at Y, and every later documents change and PR-1 follow-up the capture depends on) and C2, C3, C5, P0, C1 and C4 are satisfied. This file does not supply those clearances.

## 5. Stop conditions

While C2 or C3 is unmet:

- Do not run a P0 listing.
- Do not make venue or data-use claims.

While C2, C3, or C5 is unmet:

- Do not capture.
- Do not make venue or data-use claims.

P0 does not wait for C5. Capture waits for C5 and also for the cleared implementation SHA (PR-0 at Z unless the owner skips PR-0, PR-1 at Y, and every later documents change and PR-1 follow-up the capture depends on), and for P0, C1 and C4. This file does not supply those clearances and does not amend [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). That document already says the P0 listing does not run until C2 and C3 are met, that the P0 listing does not depend on C5, and that nothing is captured until C2, C3, and C5 are met. The provisional venue text already in the Milestone 2 documents is not repeated here as a clearance.
