# Deployment and rollback requirements

This document lists what the owner must decide before any production deploy and before any production rollback procedure can exist. This document names no deploy host. It does not deploy. It does not define an executable production rollback. It does not call the offline replay path ready to deploy, and it does not call the capture path ready to deploy.

Written against `main` at `758defc624412666d4dea33bf76a705b6a0f7c52` (pull request #5). That SHA is not a chosen production deploy.

C2, C3, and C5 remain unmet. This file is not an attestation of any of them. Definitions stay in [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md). Assertion fields:

| Gate | Owner fills |
| --- | --- |
| C2 | ________ |
| C3 | ________ |
| C5 | ________ |

Nothing is captured until C2, C3, and C5 are met, and capture also waits for the cleared implementation SHA, P0, C1, and C4. This file does not run a P0 listing, does not capture, and does not contact a venue or counsel.

## 1. What exists today

The only workflow is `.github/workflows/ci.yml`. It has no deploy job. [RELEASE_PREP.md](RELEASE_PREP.md) records the offline `check` job: `npm ci`, `npm run test:history`, `npm run test:schemas`, `npm run typecheck`, `npm test`, `npm run demo`, then upload of `out/` as the artifact `replay-output`.

`npm run demo` replays the two committed synthetic fixtures and writes, under `out/baseline/` and `out/riskgate/`:

- `results.json`
- `no_trade.ledger.jsonl`
- `unsteered.ledger.jsonl`
- `steered.ledger.jsonl`

Those files are synthetic research output. The upload is not a release bundle and not a capture.

## 2. Repeating an offline replay

This is the recovery the repository can actually run. It is a second offline replay at one commit. It is not a production rollback.

1. Check out the commit to repeat. The fixtures are the committed files `fixtures/synthetic-baseline.jsonl` and `fixtures/synthetic-riskgate.jsonl` at that commit.
2. Run `npm ci`, then `npm run demo`.
3. Compare the six ledger files above with a previous run of the same commit. `results.json` stores the output path of each ledger under `ledgers`, so compare that file only when both runs used the same output path string. Console text includes wall time and is not a comparison artifact.
4. A configuration the engine rejects does not create the output directory or a ledger file ([REPLAY.md](REPLAY.md)).

`tests/engine.test.ts` (`replay determinism`) replays `baseline` and `riskgate`, each as `no_trade`, `unsteered`, and `steered`, twice, and requires identical ledger JSONL and identical run summaries. The CLI writes each ledger line from that same replay.

A repeat does not restore a host, does not remove a `replay-output` artifact already uploaded, and does not move `main`.

Venue-feed reconnection is a data-plane note in [M2_DATA_SOURCE_DECISION.md](M2_DATA_SOURCE_DECISION.md) section 2. This file does not restate it and does not turn it into an operations procedure.

## 3. Decisions required before a deploy target is chosen

The owner fills every blank before any deploy workflow is added and before any deploy runs. The committed copy of this file keeps the blanks. Filling them is a later owner change. No row below chooses a host.

| Decision | Owner fills |
| --- | --- |
| Target kind | ________ |
| Target identifier | ________ |
| Operator | ________ |
| Git SHA to place on the target | ________ |
| What is placed there | ________ |
| Deploy workflow | ________ |
| Credentials the target would need | ________ |
| Data allowed on the target | ________ |
| Who approves a deploy | ________ |
| How the running SHA is confirmed | ________ |

Until `Target identifier` is filled by the owner in a later change, no deploy target exists in this repository.

A filled table still does not authorize capture. Nothing is captured until C2, C3, and C5 are met, together with the cleared implementation SHA, P0, C1, and C4.

## 4. Decisions required before a rollback procedure can exist

An executable rollback needs a chosen target and a known-good SHA. Neither is chosen here. This file does not define an executable production rollback.

| Requirement | Owner fills |
| --- | --- |
| Previous known-good SHA | ________ |
| Control-plane action | ________ |
| State on the target that a git checkout does not restore | ________ |
| Whether generated `out/` on the target is removed | ________ |
| Who may roll back | ________ |
| How the owner checks the target afterward | ________ |

A future procedure, once those blanks are filled, has to say at least:

- the target identifier from section 3
- the SHA being left and the previous known-good SHA being restored
- the control-plane action, which stays blank until the target kind is chosen
- the check that the target is on the restored SHA, then the offline commands in [RELEASE_PREP.md](RELEASE_PREP.md) section 2

Rollback of a target does not unpublish Git history, a pull request, or a CI artifact already uploaded.

## 5. Git history is not a production rollback target

Parents of the commits [RELEASE_PREP.md](RELEASE_PREP.md) records are history of those commits. They are not filled into `Previous known-good SHA`. That field stays ________ in this file.
