# t1780u assumptions

Task t1780u, Markout v1 offline evaluation scope. Worktree `C:\Users\Bthor\src\markout-t1780u-offline-v1-wt`, branch `cos/t1780u-offline-v1`, base `ac34e3771158985fef0c9062fce064c5539ef6da`. Written on 2026-10-02 after read-only inspection, before any other edit in this task.

Labels: **verified** means checked in this worktree, with the evidence cited. **Inferred** means reasoned from evidence but not checked directly. **Unknown** means not established; the entry says how the task handles it. No assumption here is used to pass, meet, or clear an owner gate.

## Task input and workspace

**A1 (verified).** The task message this session received stops mid-sentence ("Historical remain"). The complete brief is the `-p` argument of this session's own process. Evidence: `Get-CimInstance Win32_Process` for PID 44816 shows `claude.exe -p "# t1780u Markout v1 offline evaluation scope ..."` (10,874 characters, `--model claude-opus-5-5`), and its opening text matches the received message. Effect: items 1 to 8, the Git section, and RESULT.md are taken from that full brief.

**A2 (verified).** `HEAD` and `origin/main` are both `ac34e3771158985fef0c9062fce064c5539ef6da`. The branch is clean, has no upstream, and has no remote branch. No pull request exists for it, and no pull request is open in the repository. Evidence: `git rev-parse`, `git status`, `git ls-remote --heads origin cos/t1780u-offline-v1` (empty), `gh pr list` (empty).

**A3 (verified at inspection; inferred afterwards).** This session is the only writer. Evidence: the process list shows no other Claude Code or Codex process. The six other worktrees (`git worktree list`) are on other branches and are not touched. It is inferred that nothing else writes here during the task.

**A4 (verified).** No local pre-push hook is installed. `core.hooksPath` is unset, and the common hooks directory holds only samples, so a push runs no local A10 check. Effect: the A10 history scan is run by hand before the push.

## Product and code facts (audit claims re-checked)

**A5 (verified).** There is no `src/capture`, and there is no network client under `src/`. A search of `src/` for `fetch`, `axios`, `undici`, `WebSocket`, `wss://`, `http(s)://`, `api.kraken`, `node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram`, `child_process` and `spawn` finds nothing. The only hit for the wider pattern is a regular expression `.exec(` at `src/core/money.ts:93`. No file under `src/` mentions Kraken.

**A6 (verified).** The CLI has two commands, `replay` and `generate-fixtures` (`src/cli/main.ts:219-232`). `replay` defaults to scenario `baseline` (`main.ts:56`) and to that scenario's fixture file (`main.ts:59`). The fixture catalog names `fixtures/synthetic-baseline.jsonl` and `fixtures/synthetic-riskgate.jsonl` (`src/market/synthetic.ts:232-234`), with venue `synthetic-clob` (`synthetic.ts:188`, `synthetic.ts:214`). Both committed fixture headers say `synthetic: true` and carry the synthetic label.

**A7 (verified, a correction to the audit).** `replay --fixture <path>` loads any path. `validateHeader` accepts a non-synthetic fixture whose `provenance.source` is `"recorded"` without any rights check (`src/market/events.ts:216-224`). So "data with documented rights for the intended use" is a duty of whoever supplies such data; the engine does not enforce it. Effect: no document in this change claims that the engine checks rights, and no engine behavior changes.

**A8 (verified, a correction to the audit).** `package.json` has more scripts than the audit listed: `typecheck`, `test`, `test:watch`, `test:schemas`, `test:history`, `proof:mutations`, `proof:schema-mutations`, `replay`, `fixtures`, `demo` and `check` (`package.json:11-23`). None mentions `kraken`, `wss`, or `api.kraken`.

**A9 (verified).** The files `schemas/examples/*.json` are constructed illustrations. The capture-record examples' description says some book values reuse the official kraken-cli test fixture (MIT licence, commit `aa56e5976be5`), and `fixture.v2.examples.json` points to that note. Evidence: line 2 of each file. Effect: nothing is copied from them.

## Gate documents and their locks

**A10 (verified).** The v1 gate status lives in `docs/OWNER_GATE_STATUS.md`. `scripts/gate-status-check.mjs` enforces it; that script also reads `docs/OWNER_P0_READINESS.md`, `docs/POST_MERGE_OWNER_PACKET.md` and `docs/DEPLOYMENT_ROLLBACK.md`. `tests/gate-status-blanks.test.ts` runs the script. The definitions of C2, C3 and C5 stay in `docs/M2_DATA_SOURCE_DECISION.md` sections 1 and 4. Evidence: `OWNER_GATE_STATUS.md:5` and `:11-15`, `gate-status-check.mjs:57-91`, `gate-status-blanks.test.ts:13-14`, brief item 1.

**A11 (verified).** The current checker finds status rows with `/^\| C\d \| [A-Z]+ \|/` (`gate-status-check.mjs:73`). That pattern cannot match `OUT_OF_SCOPE`, which contains underscores. Effect: the row filter changes together with the status value.

**A12 (verified).** This task must not change any path that handoff Gate and sequence step 2 compares. After pull request #3, a change to any of them is its own step 3a documents pull request with its own exact-SHA QA. The compared paths are:

- `docs/M2_*.md`
- `schemas/`
- `tests/jsonl-policy.ts`
- `tests/a10-history-cli.ts`
- `tests/repository-jsonl.test.ts`
- `tests/capture-structure.ts`
- `tests/capture-structure.test.ts`
- `tests/handoff-gates.test.ts`
- `tests/schemas.test.ts`
- `.githooks/pre-push`
- `.github/workflows/ci.yml`
- `.gitignore`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`

Evidence: `tests/handoff-gates.test.ts:68`, and the brief, which forbids rewriting the M2 documents, `schemas/` and `fixtures/`. Effect: no new npm script, no CI change, and no configuration change. The new test file runs under the existing `tests/**/*.test.ts` include (`vitest.config.ts:5`). The new module is typechecked under the existing `src/**/*.ts` include (`tsconfig.json:21`).

**A13 (verified).** `tests/handoff-gates.test.ts` pins these lines in `docs/RELEASE_PREP.md` (`tests/handoff-gates.test.ts:514-523`):

- "While C2 or C3 is unmet:"
- "- Do not run a P0 listing"
- "While C2, C3, or C5 is unmet:"
- "- Do not capture"
- "P0 does not wait for C5. Capture waits for C5"

That test cannot change (A12), so these stop-lines stay. The brief allows keeping them, and they stay true, because the gates are not met.

**A14 (verified).** `tests/handoff-gates.test.ts` reads `README.md` and every top-level `docs/*.md`. It does not read `docs/audit/`, because `readdirSync` is not recursive. It enforces four rules:

- It refuses an HTML comment opener, some HTML block tags, link reference definitions, character references, and some withdrawn wordings (`tests/handoff-gates.test.ts:71-74`, `:356-362`).
- A README sentence that gates a capture on C2 or C3 must also name C5 (`:591-599`).
- The README Milestone 2 bullet is pinned whole (`:481`).
- A backticked `.md`, `.rs`, `.go` or `.py` path in README must be internal or appear in the decision's citation ledger (`:667-684`).

Effect: the new README bullet and `docs/C5_RESEARCH_NOTE_2026-10-02.md` are written to these rules.

**A15 (verified).** `tests/offline-ops.test.ts` locks three documents:

- `docs/DEPLOYMENT_ROLLBACK.md`: blank target fields, blank C2, C3 and C5 rows, no "C2 is met", no "production-ready", no URL, no IP address, and no host vendor names.
- `docs/RELEASE_PREP.md`: the recorded commits, the pull request #6 merge as the only recorded tip, and the stop-lines.
- `docs/POST_MERGE_OWNER_PACKET.md`: blank rows, and pull request #6 noted as history.

Evidence: `tests/offline-ops.test.ts:13-112`. Effect: only the two "remain unmet" lead-sentence locks change. Every other lock stays.

**A16 (verified as a rule; the clean result is confirmed by test runs).** The A10 rule refuses tracked paths under `captures/` or `normalized/`. It classifies `*.jsonl` and `*.normalize-report.json` files. It content-checks every other tracked file, and each commit message, for a raw capture record on a line (`tests/jsonl-policy.ts:4-35`, `:208-216`, `:620-622`, `:854`). The new files hold no JSON, no venue payload, and no sample trade.

## Scope decisions

**A17 (inferred).** "OUT OF SCOPE FOR V1" is the owner's v1 product direction, delivered through the brief. It is not an owner attestation on pull request #3, and it does not meet, pass, or clear any gate. The repository holds no owner record of the decision beyond this task.

**A18 (inferred).** Some locked sentences say that capture waits until C2, C3 and C5 are met, or that the gates stay unmet. Examples: `DEPLOYMENT_ROLLBACK.md:15`, `OWNER_GATE_STATUS.md:82`, `POST_MERGE_OWNER_PACKET.md:9`. These stay true under OUT OF SCOPE FOR V1, because the gates are still not met. Only the three status rows must not say UNMET (brief item 2). The historical "remain unmet" sentences in the M2 revision notes stay untouched (brief).

**A19 (inferred; a judgment call beyond "add one bullet").** README lines 77 and 78 say "C2, C3, and C5 remain unmet". That stays true, and those lines stay. README line 79 describes `OWNER_GATE_STATUS.md` as "the evidence the owner must post for C2, C3, and C5, all UNMET". That description would contradict the new status rows, so this change rewords it, next to the new bullet. The Milestone 2 bullet is not edited. Review can reverse this rewording on its own.

**A20 (inferred).** By design, the disabled module `src/market/kraken-adapter.ts` has no production caller (brief item 7). It carries the reopen rule in code. It must stay unreachable from `src/cli/main.ts` and `src/index.ts`, and it holds no network code.

## Research note

**A21 (inferred; not independently checked, by design).** The sentences the C5 note quotes were read from the official pages on 2026-10-02 by the brief's author. This session makes no Kraken request and does not re-read those pages. The note attributes the quotes that way and labels every paraphrase as a paraphrase.

**A22 (inferred).** The note quotes short definitional sentences and cites four documentation URLs. That is not a Kraken payload, not sample trade JSON, and not retained market data. The brief asks for exactly these quotes.

## Environment and process

**A23 (verified; the CI result is unknown).** `node_modules` is absent. The brief allows `npm ci`, which installs from the registry according to `package-lock.json` and makes no Kraken request. Local versions are Node v24.19.0 and npm 12.0.2. CI uses Node 22 (`.github/workflows/ci.yml:18`), and `engines.node` is `>=22.4` (`package.json:9`). Whether the suite behaves the same on Node 22 is unknown until CI runs on the draft pull request.

**A24 (verified).** The brief authorizes pushing `cos/t1780u-offline-v1` and opening a draft pull request. It does not authorize merging, undrafting, approving, an admin bypass, a push to `main`, a deploy, or any Kraken request.

**A25 (inferred).** RESULT.md records the pushed commit SHA and the draft pull request URL, and neither exists until after the commit and push. So RESULT.md is written last and left uncommitted. Committing it would move the draft pull request's head off the tested SHA.

**A26 (verified).** This session runs as `claude-opus-5-5`. Evidence: the session's system prompt, and `--model claude-opus-5-5` in the process command line (A1).

## Unknowns not resolved, and why that is safe

- **U1.** The following are unknown and are not invented: legal permission for any Kraken use, the jurisdiction of a host or an operator, the currency of the terms, and every live decision section 4 reading. v1 needs none of them. All of them return with C2, C3 and C5 if a Kraken adapter is pursued.
- **U2.** It is unknown whether the four Kraken documentation pages still read as quoted, because no request is made. The note is dated, and it is not a C5 reading.
- **U3.** The CI result on the draft pull request is unknown at the time of writing.
