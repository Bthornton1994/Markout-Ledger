// Acceptance cases for the gates the owner and the implementer read before any build or capture (docs/M2_GROK_HANDOFF.md,
// "Gate and sequence"; docs/M2_DATA_SOURCE_DECISION.md section 1): the order from pull request #3 to PR-0 and PR-1, the
// C5 capture gate, the independent QA of one exact commit, and the limits of the A10 layers and of the normalize-report
// checks, which no document may present as complete. These are text checks: each fails when the sentence it guards is
// removed or reworded, or when a known earlier wording returns, not when someone ignores a gate. They cannot see a gate
// weakened by words added outside the guarded text or by a contradicting sentence elsewhere, and they read the documents
// of the tree under test, so a change that weakens a document and its guard together passes (contract section 6.5; review
// is the control for that).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const handoff = read('docs/M2_GROK_HANDOFF.md');
const decision = read('docs/M2_DATA_SOURCE_DECISION.md');
const contract = read('docs/M2_DATA_CONTRACT.md');
const readme = read('README.md');
const requirements = read('docs/DATA_REQUIREMENTS.md');
const prompt = handoff.slice(handoff.indexOf('## 6. Paste-ready prompt'));
const gate = handoff.slice(handoff.indexOf('**Gate and sequence.**'), handoff.indexOf('## 0. Prerequisite PR-0'));
const row = (id: string): string => handoff.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';
const blocked = handoff.slice(handoff.indexOf('## 5. What remains blocked'), handoff.indexOf('## 6. Paste-ready prompt'));
const protocol = read('docs/M2_EVALUATION_PROTOCOL.md');
const docs: [string, string][] = [
  ['README.md', readme],
  ['docs/M2_EVALUATION_PROTOCOL.md', protocol],
  ['docs/DATA_REQUIREMENTS.md', requirements],
  ['docs/M2_DATA_CONTRACT.md', contract],
  ['docs/M2_DATA_SOURCE_DECISION.md', decision],
  ['docs/M2_GROK_HANDOFF.md', handoff],
];
/** A sentence anchored whole: after a line start (and a list marker, step number or bold title) or after ". ", and followed
 * by a space or the line end, so a word added inside it fails. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const whole = (s: string): RegExp => new RegExp(`(?:^(?:- |\\d+a?\\. )?(?:\\*\\*[^*\\n]+\\*\\* )?|\\. )${esc(s)}(?= |$)`, 'm');
/** The paths handoff Gate and sequence step 2 compares. */
const COMPARED = ['docs/M2_DATA_CONTRACT.md', 'docs/M2_DATA_SOURCE_DECISION.md', 'docs/M2_EVALUATION_PROTOCOL.md', 'docs/M2_GROK_HANDOFF.md', 'schemas', 'tests/jsonl-policy.ts', 'tests/a10-history-cli.ts', 'tests/repository-jsonl.test.ts', 'tests/capture-structure.ts', 'tests/capture-structure.test.ts', 'tests/handoff-gates.test.ts', 'tests/schemas.test.ts', '.githooks/pre-push', '.github/workflows/ci.yml', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];
/** README.md and every document under docs/ (REPLAY.md, which S7 has PR-1 edit, included): the scope of the checks that
 * an earlier wording is gone. */
const allDocs: [string, string][] = [
  ['README.md', readme],
  ...readdirSync(new URL('../docs/', import.meta.url)).filter((f) => f.endsWith('.md')).sort().map((f): [string, string] => [`docs/${f}`, read(`docs/${f}`)]),
];

// The units (sentences, or table rows) that mention a capture and C2 or C3 without C5 but are not capture gates: the
// definitions of C2 and C3 and of their re-confirmation, revision notes, publication rules, and the prompt's start gate
// for any work, whose capture clause is its own sentence. A new unit of that kind must be added here by name, so a new
// capture gate that leaves out C5 cannot pass unnoticed.
const NOT_GATES = [
  'C2 requires each of four uses (automated first-party access',
  'Second revision 2026-09-23: decision condition C2 is now met only when',
  'Third revision 2026-09-23 (after the read-only QA of `0ed04a7`)',
  'C2 use (iv) now covers every output derived from captured data',
  "Use (iv)'s normalize reports now have a closed format",
  'C2 and C3 are re-confirmed before each capture day (§1).',
  'For C2, use (iv) counts as cleared when, and only when,',
  'Before the P0 listing and before each capture day, the owner confirms on pull request #3',
  'What counts as recorded data depends on the kind of value',
  'C3 is met only when the owner confirms in writing on pull request #3',
  '| A10 | rights gate and repository hygiene |',
  "The owner's readings, reported on 2026-09-23, are recorded as [O]",
  'Do not start anything until the owner confirms all of the following on pull request #3',
  'The OWNER runs the capture on the host confirmed under C3',
  'Every output of this protocol computed from a recorded capture',
  'Decision condition C3, like C2, must be current before the P0 listing as well as before each capture day',
  'C3, like C2, must now be current before the P0 listing as well as before each capture day',
];

describe('the order from pull request #3 to PR-0 and PR-1 (handoff, Gate and sequence)', () => {
  it('states that main lacks the contract until the owner merges pull request #3, and orders the steps', () => {
    expect(gate).toMatch(/exist only on pull request #3's branch until the owner merges it: `main` has none of them/);
    const steps = ['Independent QA of one exact commit', 'The owner merges pull request #3 while its head is X', 'P0 (owner only)', 'A documents change after the merge', '**PR-0**', '**PR-1**'];
    const at = steps.map((s) => gate.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('checks the merge by identity and by content, not by ancestry alone, and never lets the implementer merge', () => {
    expect(gate).toMatch(/Identity: pull request #3 is merged and its last commit is X/);
    expect(gate).toMatch(/`git merge-base --is-ancestor X origin\/main` alone is not enough, since it also holds when a later, unreviewed head was merged/);
    expect(gate).toMatch(/Content: on the commit the branch starts from, the contract's files equal X's, `git diff --quiet X <that commit> -- docs\/M2_DATA_CONTRACT\.md .*tests\/capture-structure\.ts .*\.githooks\/pre-push/);
    expect(gate).toMatch(/which also catches a revert and a merge that changed them/);
    expect(gate).toMatch(/Only the owner merges; the implementer never merges and never pushes to pull request #3/);
  });

  it('compares the same full list of contract paths in the gate and the prompt, and stops when a merged PR-0 changed one', () => {
    const expected = COMPARED;
    const list = (text: string, marker: string): string[] => {
      const i = text.indexOf(marker);
      expect(i).toBeGreaterThanOrEqual(0);
      return text.slice(i + marker.length).split(/[`,;]|\s+succeeds\b/)[0]!.trim().split(/\s+/);
    };
    expect(list(gate, '`git diff --quiet X <that commit> -- ')).toEqual(expected);
    expect(list(prompt, 'git diff --quiet X <the commit you branch from> -- ')).toEqual(expected);
    expect(gate).toMatch(/PR-0 never changes any of these paths\. PR-1 changes only two of them, `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts`, and only to add the A10 extension of the recorded kind/);
    expect(gate).toMatch(/If a merged PR-0 has changed any of these paths, the implementer stops and reports/);
    expect(row('PA6')).toMatch(/never a path that Gate and sequence step 2 compares/);
  });

  it('allows PR-1 exactly one change to a compared path, the A10 extension, and every place that asks for it names the same two files', () => {
    expect(gate).toMatch(/which adds refusals and removes none; PR-1's description lists those changes, and the exact-SHA QA that clears PR-1 \(step 5\) covers them/);
    expect(gate).toMatch(/Once PR-1 has merged, those two paths are compared with Y, the SHA at which that QA cleared PR-1 \(step 5\), instead of X/);
    expect(gate).toMatch(/repeats step 2's content check on that `main` commit, each path against its baseline as step 2 says \(for the paths that change changed, its cleared SHA\)/);
    expect(row('A10')).toMatch(/PR-1 extends the recorded kind, in `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts` \(the one change to a compared path that Gate and sequence step 2 allows PR-1\)/);
    expect(handoff).toMatch(/the PR description lists every change to `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts`, the only compared paths PR-1 changes and only for the A10 extension \(Gate and sequence step 2\), for the owner's review; `tests\/a10-history-cli\.ts`, `\.githooks\/pre-push` and `\.github\/workflows\/ci\.yml` are unchanged/);
    expect(prompt).toMatch(/extend it as A10 says, in tests\/jsonl-policy\.ts and tests\/repository-jsonl\.test\.ts only, adding refusals and removing none \(the only change you make to a path the check of \(2\) compares\)/);
    expect(contract).toMatch(/PR-1 extends kind \(2\), in `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts` \(the one change to a compared path that handoff Gate and sequence step 2 allows PR-1\)/);
    // The wording that asked PR-1 to change other compared paths, or no compared path at all, is gone everywhere.
    for (const [name, text] of allDocs) {
      expect(text, name).not.toMatch(/PR-0 and PR-1 never change these paths/);
      expect(text, name).not.toMatch(/lists every change to `tests\/jsonl-policy\.ts`, `tests\/a10-history-cli\.ts`/);
    }
  });

  it('defines the exact-SHA QA that clears PR-1 with step 1\'s checks, and names its cleared SHA as the baseline once PR-1 has merged (Q1)', () => {
    const step5 = gate.slice(gate.indexOf('5. **PR-1**'));
    expect(step5).toMatch(/PR-1 is cleared the way step 1 clears pull request #3: a read-only QA clears one full 40-character commit SHA of PR-1, called Y here/);
    expect(step5).toMatch(/the reviewer verifies, when the QA starts and again when it reports, that Y is the live head of PR-1, and says so in the report/);
    expect(step5).toMatch(/having authored neither Y, nor any other commit of PR-1, nor any of its self-audits, and not being an agent or session run or created by a session that did \(the implementer, its session and every session, subagent or agent that session created or ran, directly or through another session or agent, are not independent\)/);
    expect(step5).toMatch(/any later push to PR-1 voids the clearance, and no earlier QA transfers to another SHA/);
    expect(step5).toMatch(/The owner merges PR-1 only while its head is Y, checked as step 2 checks X \(identity: PR-1 is merged and its last commit is Y\), and only while Y contains every step 3a change already merged;/);
    expect(step5).toMatch(/Once PR-1 has merged, step 2's content check compares `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts` with Y and every other compared path with X, each unless a step 3a change merged later has changed it, in which case with the cleared SHA of the one merged last\./);
    expect(prompt).toMatch(/cleared by an exact-SHA QA under handoff Gate and sequence step 5 \(the checks and independence of step 1 applied to PR-1: a reviewer who is not you, your session or any session or agent it created or ran, nor the authors' session of pull request #3 or any session or agent it created or ran, in each case directly or through another session or agent, verifies that the SHA it clears is PR-1's live head when the QA starts and when it reports, and any later push voids it\) before the owner merges it while its head is that SHA and that SHA contains every step 3a change merged by then:/);
    // The undefined phrases the re-audit of e8764f1 found (Q1) are gone.
    for (const [name, text] of allDocs) {
      expect(text, name).not.toMatch(/PR-1's own (exact-SHA )?QA/);
      expect(text, name).not.toMatch(/PR-1's cleared SHA/);
    }
  });

  it('routes every change to a schema, its examples or tests/schemas.test.ts through its own step 3a pull request with its own exact-SHA QA, never PR-1 (Q2)', () => {
    expect(gate).toMatch(/Any change to the contract's documents, to a schema under `schemas\/`, to its examples under `schemas\/examples\/`, to `tests\/schemas\.test\.ts`, to the reference checker `tests\/capture-structure\.ts` or its vectors `tests\/capture-structure\.test\.ts`, or to any other path step 2 compares \(PR-1's A10 extension of step 2 excepted\) after pull request #3 merges/);
    expect(gate).toMatch(/is its own documents pull request, cleared under step 1's rules applied to that pull request/);
    expect(row('S7')).toMatch(/the contract documents \(`docs\/M2_\*\.md`\), `schemas\/` \(the schemas and `schemas\/examples\/`\), `tests\/schemas\.test\.ts` and the reference checker `tests\/capture-structure\.ts` with its vectors `tests\/capture-structure\.test\.ts` stay the source of truth and PR-1 never edits them/);
    expect(handoff).toMatch(/PR-1 changes no schema, no file under `schemas\/examples\/` and not `tests\/schemas\.test\.ts` \(S7, Gate and sequence step 2\): a change to any of the three JSON Schemas is its own documents pull request under Gate and sequence step 3a, with its own exact-SHA QA, and updates `schemas\/examples\/` and `tests\/schemas\.test\.ts` in that pull request/);
    expect(prompt).toMatch(/you change no schema, no file under schemas\/examples and not tests\/schemas\.test\.ts: a schema change, with its examples and tests\/schemas\.test\.ts, is its own documents pull request under handoff Gate and sequence step 3a with its own exact-SHA QA, never part of PR-1/);
    // The wording that put a schema change inside PR-1 (Q2) is gone.
    for (const [name, text] of allDocs) {
      expect(text, name).not.toMatch(/`?tests\/schemas\.test\.ts`? in the same (PR|pull request)\b/);
      expect(text, name).not.toMatch(/updating schemas\/examples and tests\/schemas\.test\.ts with any schema change/);
    }
  });

  it('corrects a wrong normalizer in PR-1 and a wrong reference checker, vector or text only in its own step 3a pull request, never in PR-1 (B1)', () => {
    expect(contract).toMatch(/Where the two disagree, this contract decides which is wrong\. A wrong normalizer is corrected in PR-1\. A wrong reference checker or vector, and this text where it is wrong, are corrected in their own documents pull request under handoff Gate and sequence step 3a, with its own exact-SHA QA, which PR-1 takes in before any capture; PR-1 never edits `tests\/capture-structure\.ts` or `tests\/capture-structure\.test\.ts`/);
    expect(contract).toMatch(/- Reference checker: a change to `tests\/capture-structure\.ts` or `tests\/capture-structure\.test\.ts` is made together with any change to the contract text it implements \(§5\.11\), and, after pull request #3 merges, only in its own documents pull request under handoff Gate and sequence step 3a, never in PR-1/);
    expect(gate).toMatch(/a reference checker, vector or contract text that contract §5\.11 finds wrong where PR-1's normalizer and the reference disagree/);
    expect(row('S7')).toMatch(/any correction, whatever its cause, is a separate documents pull request under Gate and sequence step 3a, which PR-1 takes in before any capture/);
    expect(row('A7')).toMatch(/where the normalizer and the reference disagree, contract §5\.11 decides: a wrong normalizer is corrected in PR-1, and a wrong reference checker or vector is corrected only in its own documents pull request under Gate and sequence step 3a, which PR-1 takes in before any capture, never in PR-1/);
    expect(handoff).toMatch(/- PR-1 changes neither the reference checker `tests\/capture-structure\.ts` nor its vectors `tests\/capture-structure\.test\.ts` \(S7, Gate and sequence step 2, contract §5\.11\)/);
    expect(row('A7')).toMatch(/the test takes every vector's raw stream without changing `tests\/capture-structure\.test\.ts` \(run with `CAPTURE_VECTORS_OUT` set to a directory outside the repository, that file writes there every raw stream the reference judges/);
    expect(prompt).toMatch(/taking every vector's raw stream by running tests\/capture-structure\.test\.ts with CAPTURE_VECTORS_OUT set to a directory outside the repository/);
    expect(contract).toMatch(/run with `CAPTURE_VECTORS_OUT` set to a directory outside the repository, `tests\/capture-structure\.test\.ts` writes there every raw stream the reference judges, listed with its vector in `vectors\.json`, so PR-1's test takes the streams without changing it/);
    expect(prompt).toMatch(/you never edit either file: where your normalizer and the reference disagree and the reference or a vector is wrong, report it in your PR description with the assumption you made; it is corrected in its own documents pull request under handoff Gate and sequence step 3a, which you then take into PR-1 before any capture/);
    expect(prompt).toMatch(/nor do you change tests\/capture-structure\.ts or tests\/capture-structure\.test\.ts: a wrong reference checker or vector is corrected in its own step 3a documents pull request, never in PR-1/);
    // The sentence that put both corrections in the same pull request (B1) is gone everywhere.
    const reference = read('tests/capture-structure.ts');
    expect(reference).toMatch(/a wrong\n\/\/ normalizer is corrected in PR-1, and a wrong reference, vector or contract text in its own documents pull request\n\/\/ under handoff Gate and sequence step 3a, never in PR-1/);
    for (const [name, text] of [...allDocs, ['tests/capture-structure.ts', reference] as [string, string]]) {
      expect(text, name).not.toMatch(/both are corrected/);
      expect(text, name).not.toMatch(/corrected in the same pull request/);
    }
  });

  it('gives every compared path its own baseline, the cleared SHA of the last cleared change to it, in step 2, step 5 and the prompt (N6)', () => {
    expect(gate).toMatch(/Each path has its own baseline: X, or, for a path that a change cleared later has changed since \(a step 3a change, or PR-1 for its two A10 paths, below\), the cleared SHA of the cleared change merged last that changed that path/);
    expect(gate).toMatch(/; a path that differs from its baseline fails the check, also when it equals an earlier baseline \(after a revert, for example\)\./);
    expect(gate).not.toMatch(/equals none of the SHAs it could be compared with/);
    expect(gate).toMatch(/those two paths are compared with Y, the SHA at which that QA cleared PR-1 \(step 5\), instead of X, until a later step 3a change changes them/);
    expect(gate).toMatch(/5\. \*\*PR-1\*\*, on a branch created from a `main` that passes step 2's checks \(each path compared with its baseline as step 2 says\)/);
    expect(prompt).toMatch(/\(a path that a later cleared change has changed, a change under handoff Gate and sequence step 3a or, for tests\/jsonl-policy\.ts and tests\/repository-jsonl\.test\.ts, PR-1 once merged, is compared instead with the cleared SHA of the one merged last, as handoff steps 2 and 5 say\), and every pull request merged since X under handoff Gate and sequence step 3a is merged with its last commit the SHA its QA cleared, as GitHub shows it; stop and report if any of these fails;/);
    expect(prompt).toMatch(/passes the check of \(2\) above \(each path against X, or the cleared SHA of the step 3a change merged last that changed it\)/);
    // The single-SHA wording for the whole list is gone.
    for (const [name, text] of allDocs) {
      expect(text, name).not.toMatch(/the comparison is with the cleared SHA of the last such change instead/);
      expect(text, name).not.toMatch(/the same comparison with that change's cleared SHA/);
      expect(text, name).not.toMatch(/against X, or the cleared SHA of the last documents change/);
    }
  });

  it('excludes the authors\' session of pull request #3 and everything it created from clearing PR-1, and names who checks PR-1\'s merge (N7, N8)', () => {
    const step5 = gate.slice(gate.indexOf('5. **PR-1**'));
    expect(step5).toMatch(/neither are the authors' session of pull request #3 \(`https:\/\/claude\.ai\/code\/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of its commits\) and every session, subagent or agent it created or ran, directly or through another session or agent;/);
    expect(step5).toMatch(/the implementer makes that identity check, as GitHub shows it \(`git merge-base --is-ancestor Y origin\/main` alone is not enough\), and the content check below at once after the owner merges PR-1, before any later branch starts from that `main` and before any capture from a checkout of it, reports the result as a comment on PR-1, and stops and reports if either fails/);
    expect(prompt).toMatch(/At once after the owner merges PR-1, and before any later branch from main or any capture from a checkout of it, check that PR-1 is merged and its last commit is the SHA its step 5 QA cleared, as GitHub shows it \(git merge-base --is-ancestor alone is not enough\), with the content check of \(2\), which then compares tests\/jsonl-policy\.ts and tests\/repository-jsonl\.test\.ts with that SHA, report the result as a comment on PR-1, and stop and report if it fails/);
    expect(gate).toMatch(/only while its cleared head contains every step 3a change already merged and, once PR-1 has merged, Y \(step 5\), so any two of the step 3a changes and PR-1 that `main` holds have been seen together by one QA\./);
    expect(gate).not.toMatch(/never holds a combination of cleared changes that no QA has seen/);
    expect(prompt).toMatch(/nor the authors' session of pull request #3 or any session or agent it created or ran, in each case directly or through another session or agent/);
  });

  it('assigns no schema or examples change to PR-0 or PR-1 in any where column or diff bullet (N9)', () => {
    expect(row('P5')).toMatch(/PR-0 changes no schema .* \| none \(checked, not changed\) \|$/);
    expect(row('S7')).toMatch(/\| `docs\/REPLAY\.md`, `README\.md` \|$/);
    expect(row('S7')).not.toMatch(/\.gitignore` \|$/);
    expect(handoff).not.toMatch(/the constructed examples under `schemas\/examples\/`, which are not fixtures and carry no venue data, excepted\), no credential and no order code is in the diff/);
    for (const [name, text] of allDocs) expect(text, name).not.toMatch(/no schema change is expected/);
  });

  it('needs no change to a compared path from PR-1: engines.node is already the Node version S1 relies on', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { engines?: { node: string } }> };
    expect(pkg.engines.node).toBe('>=22.4');
    expect(lock.packages['']?.engines?.node).toBe('>=22.4');
    expect(row('S1')).toMatch(/`engines\.node` is already `>=22\.4`, set by pull request #3; PR-1 changes no path Gate and sequence step 2 compares, `package\.json` included, other than the A10 extension step 2 allows/);
    expect(prompt).toMatch(/engines\.node is already >=22\.4, set by pull request #3; you change no path the check of \(2\) above compares, package\.json included, except the A10 extension of item 5/);
    for (const [name, text] of allDocs) expect(text, name).not.toMatch(/set `?engines\.node`? to/);
  });

  it('routes every contract change after the merge through its own cleared documents pull request, never through PR-0 or PR-1', () => {
    expect(gate).toMatch(/3a\. \*\*A documents change after the merge, when one is needed\.\*\* Any change to the contract's documents, to a schema under `schemas\/`, to its examples under `schemas\/examples\/`, to `tests\/schemas\.test\.ts`, to the reference checker `tests\/capture-structure\.ts` or its vectors `tests\/capture-structure\.test\.ts`, or to any other path step 2 compares \(PR-1's A10 extension of step 2 excepted\) after pull request #3 merges .* is its own documents pull request, cleared under step 1's rules applied to that pull request/);
    expect(gate).toMatch(/The implementer never makes these changes inside PR-0 or PR-1/);
    expect(gate).toMatch(/A step 3a change merged after PR-1 has branched is taken into PR-1 before any capture/);
    expect(row('S7')).toMatch(/PR-1 never edits them/);
    expect(row('S7')).not.toMatch(/edit them only to correct an error/);
    expect(prompt).toMatch(/never change the symbol or the contract yourself/);
  });

  it('guards the whole independence sentences of steps 1 and 5, and the gate sentences no other test reads (N10)', () => {
    // Whole sentences, from their first word to their period, so a word inserted inside them fails.
    expect(gate).toMatch(/(^|\. )Independent means a reviewer who authored neither X, nor any other commit of pull request #3, nor any of its self-audits, and who is not an agent or session run or created by a session that did; the authors' session \(`https:\/\/claude\.ai\/code\/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of pull request #3's commits\), every session, subagent or agent it created or ran, directly or through another session or agent, and the implementer are not independent, whoever asked for the review\. Authored means/);
    expect(gate).toMatch(/; the reviewer is independent in step 1's sense applied to PR-1, having authored neither Y, nor any other commit of PR-1, nor any of its self-audits, and not being an agent or session run or created by a session that did \(the implementer, its session and every session, subagent or agent that session created or ran, directly or through another session or agent, are not independent\); and, since pull request #3's authors wrote the contract, the reference checker and the acceptance tests PR-1 is judged against, neither are the authors' session of pull request #3 \(`https:\/\/claude\.ai\/code\/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of its commits\) and every session, subagent or agent it created or ran, directly or through another session or agent; any later push to PR-1 voids the clearance, and no earlier QA transfers to another SHA\. /);
    expect(gate).toMatch(/is its own documents pull request, cleared under step 1's rules applied to that pull request \(its full SHA verified as its live head when the QA starts and reports, the same independence\) and merged by the owner under step 2's checks, only while its cleared head contains every step 3a change already merged and, once PR-1 has merged, Y \(step 5\), so any two of the step 3a changes and PR-1 that `main` holds have been seen together by one QA\. Before branching from, or taking into PR-1, a `main` that contains a step 3a change, the implementer checks that change's merge as step 2 checks X \(identity: its pull request is merged and its last commit is its cleared SHA, as GitHub shows it\), and stops and reports if it fails\. The implementer never makes these changes inside PR-0 or PR-1\./);
    expect(gate).toMatch(/\n4\. \*\*PR-0\*\*, on a branch created from a `main` that passes step 2's checks, unless the owner substitutes a pair from the P0 listing\.\n/);
    expect(handoff).toMatch(/\n- Each PR is a draft and is not merged by the implementer\.\n/);
    expect(blocked).toMatch(/\n- PR-0 and PR-1 cannot start: pull request #3 has not been cleared by an independent QA at an exact SHA, and the owner has not merged it \(Gate and sequence, steps 1 and 2\)\./);
    expect(contract).toMatch(/\nEighth revision 2026-09-24 \(after the Fable read-only re-audit of `e8764f1`/);
  });

  it('branches PR-0 and PR-1 only from a main that passed that check, in the prompt too', () => {
    expect(prompt).toMatch(/grok\/m2-precision-migration created from origin\/main after the check of \(2\) above/);
    expect(prompt).toMatch(/grok\/m2-recorded-replay created from an origin\/main that passes the check of \(2\) above .* and contains PR-0 as the owner merged it, or, when .* contains that change; if a merged PR-0 changed any of the paths that check compares, stop and report/);
    expect(gate).toMatch(/5\. \*\*PR-1\*\*, on a branch created from a `main` that passes step 2's checks/);
    expect(prompt).toMatch(/identity, pull request #3 is merged and its last commit is X as GitHub shows it \(git merge-base --is-ancestor X origin\/main alone is not enough\); and content, git diff --quiet X <the commit you branch from> --/);
    // The old wording, which branched from a main without the contract, is gone everywhere.
    for (const [name, text] of allDocs) expect(text, name).not.toMatch(/branch named grok\/m2-[a-z-]+ from main\b/);
  });
});

describe('the gate sentences no qualifier may weaken (anchored whole sentences, N10)', () => {
  it('makes each step wait for the one before, and anchors steps 1 and 2 sentence by sentence', () => {
    expect(gate).toMatch(/`main` has none of them\. Nothing below starts before the step before it is complete:$/m);
    for (const sentence of [
      'The reviewer verifies, when the QA starts and again when it reports, that X is the live head of pull request #3, and says so in the report.',
      "Independent means a reviewer who authored neither X, nor any other commit of pull request #3, nor any of its self-audits, and who is not an agent or session run or created by a session that did; the authors' session (`https://claude.ai/code/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of pull request #3's commits), every session, subagent or agent it created or ran, directly or through another session or agent, and the implementer are not independent, whoever asked for the review.",
      'A clearance names X in full.',
      'Any later push to pull request #3 voids it, and no earlier QA or audit transfers to another SHA.',
      'The gate is the report that names X, never whichever QA request or comment is the latest.',
      'Only the owner merges; the implementer never merges and never pushes to pull request #3.',
      'Before branching, the implementer checks two things and stops if either fails.',
      'PR-0 never changes any of these paths.',
      'If a merged PR-0 has changed any of these paths, the implementer stops and reports.',
    ]) expect(gate, sentence).toMatch(whole(sentence));
  });

  it('clears and merges a step 3a change like pull request #3, branches PR-0 from a checked main, and anchors step 5', () => {
    expect(gate).toMatch(whole("**PR-0**, on a branch created from a `main` that passes step 2's checks, unless the owner substitutes a pair from the P0 listing."));
    expect(gate).toMatch(/and says so in the report; the reviewer is independent in step 1's sense applied to PR-1, having authored neither Y/);
    expect(gate).toMatch(/; any later push to PR-1 voids the clearance, and no earlier QA transfers to another SHA\. The owner merges PR-1 only while its head is Y, checked as step 2 checks X \(identity: PR-1 is merged and its last commit is Y\), and only while Y contains every step 3a change already merged; the implementer makes that identity check/);
  });

  it('pins whole, title and period included, every gate paragraph, row and bullet the remediation of QA 5825350168 added or changed, and its two revision notes', () => {
    // A qualifier inserted anywhere in one of these, a changed title or a dropped tail fails here; a deliberate change
    // to one of them is a step 3a documents change that updates this list with it (contract section 6.5 states the limit).
    const pinned: [string, string, string[]][] = [
      ['docs/M2_GROK_HANDOFF.md', handoff, [
        "1. **Independent QA of one exact commit.** A read-only QA clears pull request #3 at one full 40-character commit SHA, called X here. The reviewer verifies, when the QA starts and again when it reports, that X is the live head of pull request #3, and says so in the report. Independent means a reviewer who authored neither X, nor any other commit of pull request #3, nor any of its self-audits, and who is not an agent or session run or created by a session that did; the authors' session (`https://claude.ai/code/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of pull request #3's commits), every session, subagent or agent it created or ran, directly or through another session or agent, and the implementer are not independent, whoever asked for the review. Authored means wrote or generated the content, whatever a commit's git author field says: some of pull request #3's commits carry the owner's git identity as author, and all were generated by the authors' session, so that field neither disqualifies the owner nor qualifies anyone else. A clearance names X in full. Any later push to pull request #3 voids it, and no earlier QA or audit transfers to another SHA. The gate is the report that names X, never whichever QA request or comment is the latest.",
        "2. **The owner merges pull request #3 while its head is X.** Only the owner merges; the implementer never merges and never pushes to pull request #3. Before branching, the implementer checks two things and stops if either fails. Identity: pull request #3 is merged and its last commit is X, as GitHub shows it (`git merge-base --is-ancestor X origin/main` alone is not enough, since it also holds when a later, unreviewed head was merged). Content: on the commit the branch starts from, the contract's files equal X's, `git diff --quiet X <that commit> -- docs/M2_DATA_CONTRACT.md docs/M2_DATA_SOURCE_DECISION.md docs/M2_EVALUATION_PROTOCOL.md docs/M2_GROK_HANDOFF.md schemas tests/jsonl-policy.ts tests/a10-history-cli.ts tests/repository-jsonl.test.ts tests/capture-structure.ts tests/capture-structure.test.ts tests/handoff-gates.test.ts tests/schemas.test.ts .githooks/pre-push .github/workflows/ci.yml .gitignore package.json package-lock.json tsconfig.json vitest.config.ts`, which also catches a revert and a merge that changed them. Each path has its own baseline: X, or, for a path that a change cleared later has changed since (a step 3a change, or PR-1 for its two A10 paths, below), the cleared SHA of the cleared change merged last that changed that path, so different paths can be compared with different SHAs (`git diff --quiet <that SHA> <that commit> -- <that path>`); a path that differs from its baseline fails the check, also when it equals an earlier baseline (after a revert, for example). PR-0 never changes any of these paths. PR-1 changes only two of them, `tests/jsonl-policy.ts` and `tests/repository-jsonl.test.ts`, and only to add the A10 extension of the recorded kind (a recorded fixture must also load through S3's version-2 parser and re-serialize byte for byte), which adds refusals and removes none; PR-1's description lists those changes, and the exact-SHA QA that clears PR-1 (step 5) covers them. If a merged PR-0 has changed any of these paths, the implementer stops and reports. Once PR-1 has merged, those two paths are compared with Y, the SHA at which that QA cleared PR-1 (step 5), instead of X, until a later step 3a change changes them.",
        "3. **P0 (owner only).** Only after decision conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the P0 listing, C3 from a reading made on the day of the listing (decision §1); for P0, C2 includes the owner's answer on whether retaining the P0 payload is covered (decision §1 C2). Section 0 below.",
        "3a. **A documents change after the merge, when one is needed.** Any change to the contract's documents, to a schema under `schemas/`, to its examples under `schemas/examples/`, to `tests/schemas.test.ts`, to the reference checker `tests/capture-structure.ts` or its vectors `tests/capture-structure.test.ts`, or to any other path step 2 compares (PR-1's A10 extension of step 2 excepted) after pull request #3 merges (a substitute pair chosen from the P0 listing, which changes the symbol in this handoff and contract §8; a correction that C5 requires, decision §1 C5; a reference checker, vector or contract text that contract §5.11 finds wrong where PR-1's normalizer and the reference disagree; or any other correction) is its own documents pull request, cleared under step 1's rules applied to that pull request (its full SHA verified as its live head when the QA starts and reports, the same independence) and merged by the owner under step 2's checks, only while its cleared head contains every step 3a change already merged and, once PR-1 has merged, Y (step 5), so any two of the step 3a changes and PR-1 that `main` holds have been seen together by one QA. Before branching from, or taking into PR-1, a `main` that contains a step 3a change, the implementer checks that change's merge as step 2 checks X (identity: its pull request is merged and its last commit is its cleared SHA, as GitHub shows it), and stops and reports if it fails. The implementer never makes these changes inside PR-0 or PR-1. A step 3a change merged after PR-1 has branched is taken into PR-1 before any capture: the implementer brings PR-1 up to a `main` that contains it, implements it, and repeats step 2's content check on that `main` commit, each path against its baseline as step 2 says (for the paths that change changed, its cleared SHA).",
        "4. **PR-0**, on a branch created from a `main` that passes step 2's checks, unless the owner substitutes a pair from the P0 listing.",
        "5. **PR-1**, on a branch created from a `main` that passes step 2's checks (each path compared with its baseline as step 2 says) and contains any step 3a change, and, unless PR-0 is skipped, PR-0 as the owner merged it. PR-1 is cleared the way step 1 clears pull request #3: a read-only QA clears one full 40-character commit SHA of PR-1, called Y here; the reviewer verifies, when the QA starts and again when it reports, that Y is the live head of PR-1, and says so in the report; the reviewer is independent in step 1's sense applied to PR-1, having authored neither Y, nor any other commit of PR-1, nor any of its self-audits, and not being an agent or session run or created by a session that did (the implementer, its session and every session, subagent or agent that session created or ran, directly or through another session or agent, are not independent); and, since pull request #3's authors wrote the contract, the reference checker and the acceptance tests PR-1 is judged against, neither are the authors' session of pull request #3 (`https://claude.ai/code/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of its commits) and every session, subagent or agent it created or ran, directly or through another session or agent; any later push to PR-1 voids the clearance, and no earlier QA transfers to another SHA. The owner merges PR-1 only while its head is Y, checked as step 2 checks X (identity: PR-1 is merged and its last commit is Y), and only while Y contains every step 3a change already merged; the implementer makes that identity check, as GitHub shows it (`git merge-base --is-ancestor Y origin/main` alone is not enough), and the content check below at once after the owner merges PR-1, before any later branch starts from that `main` and before any capture from a checkout of it, reports the result as a comment on PR-1, and stops and reports if either fails; no branch starts from that `main`, and no capture runs from a checkout of it, until that comment reports both checks passing. Once PR-1 has merged, step 2's content check compares `tests/jsonl-policy.ts` and `tests/repository-jsonl.test.ts` with Y and every other compared path with X, each unless a step 3a change merged later has changed it, in which case with the cleared SHA of the one merged last.",
        "| P5 | `schemas/fixture.v2.schema.json` already admits eight-place sizes and `qtyDecimals <= 8`; PR-0 changes no schema (a schema change would be a documents pull request under Gate and sequence step 3a), and the byte-identical committed fixtures remain valid version-1 files | none (checked, not changed) |",
        "| S7 | **Docs and hygiene**: the `capture` and `normalize` commands in REPLAY.md and the Node requirement in README.md (`>= 22.4`); the `.gitignore` entries for `captures/` and `normalized/` already exist and stay; the contract documents (`docs/M2_*.md`), `schemas/` (the schemas and `schemas/examples/`), `tests/schemas.test.ts` and the reference checker `tests/capture-structure.ts` with its vectors `tests/capture-structure.test.ts` stay the source of truth and PR-1 never edits them: an error the implementer finds is reported in the PR with the assumption made, and any correction, whatever its cause, is a separate documents pull request under Gate and sequence step 3a, which PR-1 takes in before any capture. | `docs/REPLAY.md`, `README.md` |",
        "| A12 | real session (manual, reported) | one first-party capture of at least 60 minutes on Kraken spot `BTC/USD` (or the substitute pair chosen from the P0 listing), run by the owner on the NTP-disciplined host confirmed under C3, with the A10 pre-push hook installed in every clone on that host before the first capture (`cp .githooks/pre-push \"$(git rev-parse --git-path hooks)/pre-push\"` from a checkout of the current branch; a copy made from an earlier revision of this pull request has no self-check and is replaced), and `cmp -s .githooks/pre-push \"$(git rev-parse --git-path hooks)/pre-push\"` passing and `git status --porcelain` printing nothing from a checkout of the current branch before the first capture and before each push from that host (the `cmp` check compares the hook copy only, not the rule, scan, engine code or schemas it runs from the working tree; contract §6.5; owner steps no test verifies) (the implementer never runs a live capture and never receives raw captures or venue payloads; the owner provides the hashes, the normalize report, which is in the closed format of contract §5.10, and the derived values), only after PR-0 has landed (or a substitute pair has been chosen from the P0 listing) and the owner has posted on pull request #3 the nonprivileged attestations that meet conditions C2 (each use cleared in writing, M2_DATA_SOURCE_DECISION.md §1: automated first-party access to the public WebSocket API v2 and to the public REST endpoints the capture and P0 use (`AssetPairs`, `Time`), private retention of the raw captures on the owner's host, the research use of this project, and publication, in this public repository and its pull requests, of outputs derived from captured data other than the recorded data itself (for C2, cleared at least for the P0 statement and the A12 outputs; every other derived output, later evaluation reports and grids included, is published only once a further attested clearance names it); each by Kraken's written permission for that use or Kraken's written clarification concluding that it is permitted, or by a qualified lawyer's reasoned written opinion, from a lawyer acting for the owner (not the authors, the implementer or an AI tool), concluding that the applicable Kraken terms, read as current on a stated date, neither prohibit that use nor require Kraken's permission or consent for it; where counsel concludes, or cannot rule out, that Kraken's consent is required, only Kraken's written permission for that use clears it; model training on any capture, and publishing recorded data itself, are further uses, each excluded unless it is itself cleared, expressly and by name, under the same routes and test; recorded by the owner's nonprivileged attestation, never by the underlying record) and C3 (the owner's written confirmation on pull request #3, from the live page and with the date of that reading, that the host that runs the P0 listing and every capture is located in, and the person who operates it resides in, a US state the venue serves for spot), both re-confirmed before that capture day, and C5 (the owner's dated live-page reading of the pages decision §4 lists, posted on pull request #3, among them the three items behind `tradeIdOrdered`, `per_fill` and the 15 s liveness timeout, each resolved by one of decision C5's three routes: confirmed by the page, the contract corrected in a documents change under Gate and sequence step 3a, which counts only when the PR-1 head the owner captures with contains and implements that correction, or the owner's written decision to capture on the stated assumption) of M2_DATA_SOURCE_DECISION.md §1: normalize twice (A1), replay twice (A2) with the maker fee re-read that day, for the instrument selected after the P0 listing, on the fee schedule, the maker-rebate eligible-pairs list (searched under every name of the instrument selected after the P0 listing: `BTC/USD`, `XBT/USD`, `XBTUSD` and `XXBTZUSD` for `BTC/USD` (its WebSocket symbol and REST `wsname`, `altname` and key, the REST names from the official CLI's hand-written test row in the raw `AssetPairs` wire shape [R `kraken-cli` `src/commands/schema.rs:1017-1045`]), the WebSocket and REST names for a substitute pair), the stablecoin and FX fee page and, whenever a tier other than Tier 1 is assumed, the cross-platform tier-change article, and recorded under condition C4, report, each only as far as the owner's attested clearance of C2 use (iv) covers it, raw file hashes, fixture content hash, segment start/end reasons, `integrity` counts, `lagStatsMs`, `venueClockOffsetMs` with resolution, `clockSync`, `visibleSpanBps`, `quotesOutsideVisibleBook`, `venueStatus`, `tradeIdJumps`, drop counts, rejection counts by reason, the three-run table, whether and when the kill switch tripped in each trading run (`risk.killSwitchTripped`, and `risk.killSwitchAt` as an offset from the fixture's start, never the absolute time, which dates an observation; contract §5.10), `fills.uncertain` and `queueConsumedWithoutFill`, the pair's precisions, increments and status as derived values from both sources with the date (never the venue's verbatim payloads), and the fixture file size. The table is a single-cell mechanics check, labelled as such (M2_EVALUATION_PROTOCOL.md §4); data committed only if the A10 test passes and the owner has verified the rights note's substance (contract §6.3) |",
        "- PR-1 changes neither the reference checker `tests/capture-structure.ts` nor its vectors `tests/capture-structure.test.ts` (S7, Gate and sequence step 2, contract §5.11): where PR-1's normalizer and the reference disagree, a wrong normalizer is corrected in PR-1, and a wrong reference checker, vector or contract text is corrected in its own documents pull request under Gate and sequence step 3a, with its own exact-SHA QA, which PR-1 takes in before any capture; until then the PR description reports the disagreement and the assumption made.",
        "Do not start anything until the owner confirms all of the following on pull request #3: (1) an independent read-only QA has cleared pull request #3 at one full 40-character commit SHA X, by a reviewer who authored (wrote or generated, whatever the git author field says) neither X nor any other commit or self-audit of pull request #3 and is not an agent or session run or created by a session that did (the authors' session, https://claude.ai/code/session_012vfVeZ81tBGEeg2YZGvWVE, every session, subagent or agent it created or ran, directly or through another session or agent, and you, the implementer, are not independent), and who verified that X was the live head of pull request #3 when the QA started and again when it reported; nothing has been pushed to pull request #3 since (a clearance of any other SHA, or of \"the latest\" request, does not count); (2) the owner has merged pull request #3 while its head was X, which you check yourself before branching, both ways: identity, pull request #3 is merged and its last commit is X as GitHub shows it (git merge-base --is-ancestor X origin/main alone is not enough); and content, git diff --quiet X <the commit you branch from> -- docs/M2_DATA_CONTRACT.md docs/M2_DATA_SOURCE_DECISION.md docs/M2_EVALUATION_PROTOCOL.md docs/M2_GROK_HANDOFF.md schemas tests/jsonl-policy.ts tests/a10-history-cli.ts tests/repository-jsonl.test.ts tests/capture-structure.ts tests/capture-structure.test.ts tests/handoff-gates.test.ts tests/schemas.test.ts .githooks/pre-push .github/workflows/ci.yml .gitignore package.json package-lock.json tsconfig.json vitest.config.ts succeeds (a path that a later cleared change has changed, a change under handoff Gate and sequence step 3a or, for tests/jsonl-policy.ts and tests/repository-jsonl.test.ts, PR-1 once merged, is compared instead with the cleared SHA of the one merged last, as handoff steps 2 and 5 say), and every pull request merged since X under handoff Gate and sequence step 3a is merged with its last commit the SHA its QA cleared, as GitHub shows it; stop and report if any of these fails; (3) the nonprivileged attestations that meet decision conditions C2 and C3 are posted; (4) the owner's derived statement of the P0 listing (made only after C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, from the host confirmed under C3) and the choice between PR-0 and a substitute pair are posted, and a substitute pair, if chosen, is already in the documents through a separate documents pull request cleared and merged under handoff Gate and sequence step 3a (never change the symbol or the contract yourself). No capture (item 6) runs until decision condition C5 is also met.",
        "PR-1 (handoff section 1), on a branch named grok/m2-recorded-replay created from an origin/main that passes the check of (2) above (each path against X, or the cleared SHA of the step 3a change merged last that changed it) and contains PR-0 as the owner merged it, or, when the owner has posted a substitute pair from the P0 listing (then PR-0 is skipped and the symbol changes through a step 3a documents change), contains that change; if a merged PR-0 changed any of the paths that check compares, stop and report; as a DRAFT pull request, which is cleared by an exact-SHA QA under handoff Gate and sequence step 5 (the checks and independence of step 1 applied to PR-1: a reviewer who is not you, your session or any session or agent it created or ran, nor the authors' session of pull request #3 or any session or agent it created or ran, in each case directly or through another session or agent, verifies that the SHA it clears is PR-1's live head when the QA starts and when it reports, and any later push voids it) before the owner merges it while its head is that SHA and that SHA contains every step 3a change merged by then:",
        "Definition of done (handoff section 4): typecheck, tests (including npm run test:schemas; you change no schema, no file under schemas/examples and not tests/schemas.test.ts: a schema change, with its examples and tests/schemas.test.ts, is its own documents pull request under handoff Gate and sequence step 3a with its own exact-SHA QA, never part of PR-1; nor do you change tests/capture-structure.ts or tests/capture-structure.test.ts: a wrong reference checker or vector is corrected in its own step 3a documents pull request, never in PR-1) and demo pass; A1 to A11 and the A10 history step in CI; A12 evidence in the PR, each item only as far as the owner's attested clearance of C2 use (iv) covers it; the diff touches none of the excluded directories; each PR stays a draft. At once after the owner merges PR-1, and before any later branch from main or any capture from a checkout of it, check that PR-1 is merged and its last commit is the SHA its step 5 QA cleared, as GitHub shows it (git merge-base --is-ancestor alone is not enough), with the content check of (2), which then compares tests/jsonl-policy.ts and tests/repository-jsonl.test.ts with that SHA, report the result as a comment on PR-1, and stop and report if it fails (handoff Gate and sequence step 5). Report: branch, commit SHA, the test list with pass/fail, the owner's P0 statement, the PA and A12 tables, and every place where you found the contract ambiguous or wrong (do not silently work around it; say what you assumed).",
        "6. Real-session evidence A12, only after the owner has posted on pull request #3 the nonprivileged attestations that meet decision condition C2 (each use cleared in writing: automated first-party access to the public WebSocket API v2 and to the public REST endpoints the capture and P0 use (AssetPairs, Time), private retention of the raw captures on the owner's host, the research use of this project, and publication, in this public repository and its pull requests, of outputs derived from captured data other than the recorded data itself (for C2, cleared at least for the P0 statement and the A12 outputs; every other derived output, later evaluation reports and grids included, is published only once a further attested clearance names it); each by Kraken's written permission for that use or Kraken's written clarification concluding that it is permitted, or by a qualified lawyer's reasoned written opinion, from a lawyer acting for the owner (not the authors, the implementer or an AI tool), concluding that the applicable Kraken terms, read as current on a stated date, neither prohibit that use nor require Kraken's permission or consent for it; where counsel concludes, or cannot rule out, that Kraken's consent is required, only Kraken's written permission for that use clears it; model training on any capture, and publishing recorded data itself, are further uses, each excluded unless it is itself cleared, expressly and by name, under the same routes and test) and C3 (the owner's written confirmation on pull request #3, from the live page and with the date of that reading, that the host that runs the P0 listing and every capture is located in, and the person who operates it resides in, a US state Kraken serves for spot), both re-confirmed before the capture day, and C5 (the owner's dated live-page reading, posted on pull request #3, of the pages decision section 4 lists, among them the trade_id wording behind tradeIdOrdered, whether each trade item is one fill (per_fill), and the heartbeat cadence and idle-disconnect rule behind the 15 s liveness timeout, each resolved by one of decision C5's three routes: confirmed by the page, the contract corrected in a documents change under handoff Gate and sequence step 3a, which counts only once your PR-1 head contains and implements that correction, or the owner's written decision to capture on the stated assumption). The OWNER runs the capture on the host confirmed under C3, with the A10 pre-push hook installed in every clone on that host from a checkout of the current branch, and cmp -s .githooks/pre-push \"$(git rev-parse --git-path hooks)/pre-push\" passing and git status --porcelain printing nothing before the first capture and before each push from that host (contract section 6.5); you never run a live capture and never receive raw captures, venue payloads or the owner's underlying legal records, only the hashes, the normalize report (closed format, contract section 5.10) and the derived values the owner provides: one capture of at least 60 minutes from that NTP-disciplined host, normalized twice and replayed twice with the maker fee re-read that day, for the instrument selected after P0, on Kraken's fee schedule, maker-rebate eligible-pairs list (searched under every name of that instrument: BTC/USD, XBT/USD, XBTUSD and XXBTZUSD for BTC/USD, the REST names per the official CLI's test fixture, kraken-cli src/commands/schema.rs:1017-1045 [R]; for a substitute pair, its WebSocket symbol and REST names), stablecoin and FX fee page and, whenever a tier other than Tier 1 is assumed, cross-platform tier-change article, and recorded under decision condition C4 (never taken from the documents); put raw hashes, fixture content hash, segment reasons, integrity counts, lag statistics, venue clock offset with resolution, clock sync, visible span, quotes outside the visible book, venue status, trade-id jumps, drop and rejection counts, the three-run table, whether and when the kill switch tripped in each trading run (when as an offset from the fixture's start, never the absolute time), the fill-uncertainty counters, the pair's precisions, increments and status as derived values from both sources with the date (never the venue's verbatim payloads) and the fixture size in the PR description, each only as far as the owner's attested clearance of C2 use (iv) covers it, labelled as a single-cell mechanics check. Commit recorded data ONLY if the rights block is redistribution=permitted and publication=sample_permitted with a non-blank terms URL, check date, checker and note, the note identifying the owner's attestation on pull request #3 that records the clearance of publishing recorded data under C2, and the owner has verified that substance (the schema and the A10 test check only the note's presence and shape); until publishing recorded data is itself cleared in writing, expressly and by name, the block is redistribution=unclear (or prohibited), publication=hash_only, and you commit nothing but hashes, the normalize report and derived values; in every case those are committed or published only as far as the owner's attested clearance of C2 use (iv) covers them. Never commit a raw capture.",
      ]],
      ['docs/M2_DATA_CONTRACT.md', contract, [
        "Ninth revision 2026-09-25 (after a read-only QA of `66c19e2`, posted on pull request #3 as comment 5825350168, which ran in a session the authors' session had created): a review run in a session that the authors' session created, directly or through another session or agent, or by any of their agents, is not independent under handoff Gate and sequence step 1, whoever asked for it, so it is not the independent QA of step 1; step 1 now says so expressly, and this supersedes the sixth revision's statement that whether such a review counts is the owner's decision, which also covered the reviews of the seventh and eighth revisions and the QA of `66c19e2`; those notes are kept as written, and none of those reviews is the step-1 clearance of any SHA. Where PR-1's normalizer and the reference checker disagree, a wrong normalizer is corrected in PR-1 and a wrong reference checker, vector or text only in its own documents pull request under handoff Gate and sequence step 3a, which PR-1 takes in before any capture; PR-1's test takes the vectors' raw streams from `tests/capture-structure.test.ts` without changing it (§5.11, §9). In the handoff's Gate and sequence, step 3a now names the reference checker, its vectors and every other compared path except PR-1's A10 extension, and the owner merges a step 3a pull request only while its cleared head contains every step 3a change already merged and, once PR-1 has merged, Y (the SHA at which PR-1 was cleared, handoff step 5), and merges PR-1 only while Y contains every step 3a change already merged; each compared path is compared with the cleared SHA of the cleared change merged last that changed it, and a path that differs from it fails; the implementer checks each step 3a merge by identity; the QA that clears PR-1 excludes the authors' session of pull request #3 and every session or agent it created or ran, directly or through another; and the implementer checks PR-1's merge by identity and content at once after it, and no branch starts from, and no capture runs from, that `main` until that check has passed. The handoff's file lists for P3, P5 and S7 name no compared path, and PR-1's definition of done no longer excepts the schema examples. The content check tries each line whole as well as in parts, so a raw capture record whose string values hold NEL, U+2028 or U+2029 is found; it also trims marks, finds a record block-quoted, after a trailer token, with a trailing comma or in a one-line JSON array, and refuses a Git LFS pointer after leading white space; kind (2) refuses a raw capture record nested at any depth in a recorded fixture (§6.5). Decision condition C3, like C2, must be current before the P0 listing as well as before each capture day, from a reading made on the day of the listing and on each capture day (decision §1 C3). R10 for a last socket with no terminal record is reported at the `manifest_end` record (§5.9, §5.10); a probe's `result.unixtime` counts by its exact value, never read through a float (§5.6); a later instrument snapshot on the same socket is not refused for its `status`, and a change it shows is recorded in `venueStatus` (§6.1, §8.1, §8.4). The fixture header's cut reasons are the §5.8 list the report uses, the example `manifest_end` counts and the fixture's end record model a capture that ends with its planned `ws_close`, `manifest_end.counts` does not count itself, and the fixture header's normalizer name is `markout-ledger`, as in the report (§4.1, §6.1); the schema tests now check the examples' counts, raw files and end record against §4.1 and §5.8; where a schema bounds a shape that this text leaves open, the schema governs (§6). §6.5 no longer claims that `.gitignore` keeps a file under a capture directory out of a commit, states which force-pushed commits CI may never scan, says the hook enforces the rule, scan, engine code and schemas of its working tree, so the owner also checks `git status` on the capture host, and lists a gate document weakened together with its text check among what passes under its own weakened version. C2, C3 and C5 remain unmet.",
        "| `manifest_end` | `endedAtIso`, `clock` (§4.2), `counts` (records by type, over every record before it: it does not count itself, while the normalize report's `records.manifest_end` does, §5.10), `files` (`fileIndex`, `sha256`, `records`), `processingMs` (required: `p50`, `p99`, `max` frame-handler durations in milliseconds over every received frame, §2; all three are 0 when no frame was received) | follows the last file's `file_end`; excluded from every hash |",
        "`tests/capture-structure.ts` states the structural rules of §5.3 (the subscription gate), §5.6 (sample ownership), §5.8 (one socket per segment), R5, R9 and R10 of §5.9, and §8.1 (request, subscription and instrument identity) as code over parsed raw records: for a capture it returns the capture-level refusal, if any (R1, R1b, R5 or R10, with the record at which it found it; the normalize report names R5 by rule and field only, §5.10), and for every socket its span, settlement, gate, R9 verdict and the only records a segment of it may cover; it also lists the trade items of another pair that are `dropped.foreignSymbol` and the book messages of another pair inside a window, and returns the clock samples a given segment owns and the `venueClockOffsetMs` values computed from them. It is a reference, not a normalizer: it builds no book, verifies no checksum and emits no event. Of R1 it implements the manifest-presence clause only (the stream's first record is `manifest_start` and its last `manifest_end`, checked before any other record, as step (1) of §5.10 orders), and of R1b the file-structure clause only, not R1's field clauses or R1b's hash, order or range clauses; every vector's records are valid against the raw-record schema and its file hashes are real, so none of those clauses decides a vector before the rules the reference checks. `tests/capture-structure.test.ts` holds its vectors, each a raw stream valid against `schemas/capture-record.v1.schema.json` whose raw files are one `JSON.stringify(record)` plus `\\n` line per record with real file hashes (its `Tape` fills them in), so a normalizer's hash checks pass on every vector, among them the interleavings that motivated these rules (records between the two records of a settlement, a new socket's records before its acknowledgements, an acknowledgement or a subscription for another pair, a reconnection's instrument snapshot without the pair, and a clock step between a socket's acknowledgements and a segment). PR-1's normalizer must reach the same verdicts on every vector (handoff A7(r)); run with `CAPTURE_VECTORS_OUT` set to a directory outside the repository, `tests/capture-structure.test.ts` writes there every raw stream the reference judges, listed with its vector in `vectors.json`, so PR-1's test takes the streams without changing it. Where the two disagree, this contract decides which is wrong. A wrong normalizer is corrected in PR-1. A wrong reference checker or vector, and this text where it is wrong, are corrected in their own documents pull request under handoff Gate and sequence step 3a, with its own exact-SHA QA, which PR-1 takes in before any capture; PR-1 never edits `tests/capture-structure.ts` or `tests/capture-structure.test.ts` (handoff step 2, S7), and until that correction is merged its description reports the disagreement and the assumption made.",
        "No server-side control is claimed, and none of the three layers is complete prevention: these documents configure and verify no GitHub push restriction, ruleset or code-owner review for this repository; whether to add one (for example a ruleset, or required review of the four files named below) is the owner's decision, not made here. What no layer sees includes at least the following (the list is not exhaustive, and no layer, nor the three together, is claimed to catch every way recorded data can reach the repository or GitHub): anything published outside git, which no layer reads (a pull request's description, comments and reviews, where A12's evidence and the P0 statement go; issues; the repository wiki; releases and their assets; CI artifacts), for which the owner's review before posting is the only control; whether the attested clearance exists or covers a fixture; whether a file declared synthetic is in fact synthetic (recorded observations re-encoded in the version-1 format and labelled synthetic pass kind (1)); a venue payload, or any recorded data other than a whole raw capture record object, pasted into a string value of either fixture kind or under an undeclared key of a recorded fixture (every object of a recorded fixture accepts undeclared keys except `clockReports` and its `start` and `end` blocks, §6; PR-1's extension below refuses an undeclared key on an event, but its byte-for-byte check does not close the header, which the engine keeps as parsed); a recorded value encoded into a normalize report's constrained values (an integer in any integer field, the number of entries in an array, the choice among the enumerated codes a value may take, or bytes hex-encoded into a hash, UUID, commit or version string); objects uploaded to the repository's Git LFS store (a committed pointer is refused, above, but the store itself is outside git); a recorded value carried in a path, file, branch, tag or other ref name, or in a commit's or tag's author, committer or tagger identity (the content check reads file contents and the lines of messages and headers, and finds only a line that is one raw capture record, or a one-line JSON array holding one, in the forms listed above); recorded data in a file whose name matches none of the three kinds, or in a commit or tag message, in any form other than a raw capture record on a line of its own: a recorded fixture of any rights shape named `.ndjson`, `.json` or `.txt`, unwrapped venue frames, a normalize report under a name that does not end in `.normalize-report.json` (such as `normalize-report.json`), CSV or other exports of recorded values, and a raw capture record spread over several lines, embedded in other text other than in the forms listed above, encoded, compressed or in a file that is not UTF-8 text; a recorded value encoded into a normalize report in the other ways §5.10 lists (the choice between null and a value, whether `supersedes` is present and whether it is empty, the directory a report is committed in and how many reports of one capture are committed); a tag message or a git note pushed without the hook; and a change to the checks themselves: every layer runs the rule (`tests/jsonl-policy.ts`, with the engine code it imports from `src/` and the three schemas it reads) and the scan (`tests/a10-history-cli.ts`) of the working tree or commit under test, CI runs the `.github/workflows/ci.yml` of that commit, and the hook is the copy installed in the clone (or, through `core.hooksPath`, the checked-out `.githooks/pre-push`), so a pull request that weakens the rule, the scan, the workflow step, a gate document together with its text check (`tests/handoff-gates.test.ts`, which reads the documents of the tree under test), or what `npm ci` installs and `npm test` runs (`package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`), passes under its own weakened version, and the hook enforces those files as they stand in the working tree it runs from, an uncommitted edit included. The owner's manual verification and review remain the controls for those, and a pull request that changes any of those files is reviewed for that change. Once the engine's version-2 parser exists (handoff S3), PR-1 extends kind (2), in `tests/jsonl-policy.ts` and `tests/repository-jsonl.test.ts` (the one change to a compared path that handoff Gate and sequence step 2 allows PR-1), so that a recorded fixture must also load through it and re-serialize byte for byte, as kind (1) already must; until then a recorded fixture passes with any byte formatting and a duplicated JSON key counts with its last value, so that extension must land before any recorded fixture is committed.",
        "- JSON Schemas: a change to `schemas/capture-record.v1.schema.json`, `schemas/fixture.v2.schema.json` or `schemas/normalize-report.v1.schema.json` updates `schemas/examples/` and `tests/schemas.test.ts` in the same change, so every record type, header, event and report keeps a valid example and each new rule gets a derived failure case; after pull request #3 merges, that change is its own documents pull request under handoff Gate and sequence step 3a.",
        "- Reference checker: a change to `tests/capture-structure.ts` or `tests/capture-structure.test.ts` is made together with any change to the contract text it implements (§5.11), and, after pull request #3 merges, only in its own documents pull request under handoff Gate and sequence step 3a, never in PR-1 (§5.11).",
        "3. *Prevention, opt-in and local* (`.githooks/pre-push`). Installed once per clone by copying it into that clone's own hooks directory (`cp .githooks/pre-push \"$(git rev-parse --git-path hooks)/pre-push\" && chmod +x \"$(git rev-parse --git-path hooks)/pre-push\"`, from a checkout of the current branch, after `npm ci`), it stays active whatever commit is checked out, and it refuses the push when it cannot run: without `node_modules`, or from a checkout that lacks the scan (`tests/a10-history-cli.ts` and `tests/jsonl-policy.ts`, which it runs from the working tree). The copy is frozen when it is made. A copy that carries the self-check (every copy made from this pull request's fifth revision on) refuses the push while the checkout's own `.githooks/pre-push` differs from it, until it is copied again from a checkout of the current branch; copying the `.githooks/pre-push` of an older checkout installs a copy without that check, and a copy made from an earlier revision, including under that revision's own instructions, has none and must be replaced. All linked worktrees of a clone share the one copy in the common git directory, so worktrees whose checkouts carry different versions of `.githooks/pre-push` cannot all push without copying again. The owner checks `cmp -s .githooks/pre-push \"$(git rev-parse --git-path hooks)/pre-push\"` from a checkout of the current branch before the first capture and before each push from the capture host (handoff A12); that compares the hook copy only, not the rule, the scan, the engine code or the schemas it runs from the working tree, so at the same times the owner also checks that `git status --porcelain` prints nothing (neither check covers `node_modules`, which `npm ci` reinstalls from the lock file, and `git status` sees only uncommitted changes: a change committed on the capture host's branch shows only in that branch's diff against its cleared baselines, handoff Gate and sequence step 2). Every git command it and the scan run ignores replace refs (`GIT_NO_REPLACE_OBJECTS`), so they read the objects a push sends. Enabling it with `git config core.hooksPath .githooks` instead is weaker: that path is resolved against the working tree, so while a commit without `.githooks/pre-push` is checked out (`main` before pull request #3 is merged, or any older commit) there is no hook and pushes go through unscanned. It runs the same scan over the commits of each pushed ref (for a ref the remote already has, those between the remote's value and the pushed commit, or, when the remote's value is not in the clone (a force-push after a history rewrite, or without a prior fetch), every commit reachable from the pushed commit, and it says so; for a new remote ref, every commit reachable from the pushed commit, since the clone's remote-tracking refs may be stale) and refuses the push if any of them carries a disallowed file, or if a pushed ref does not point, directly or through an annotated tag, at a commit. It is the only layer that acts before anything is sent, and only where it is installed and not bypassed: `git push --no-verify`, `-c core.hooksPath=<elsewhere>`, a clone where it is not installed, a checkout without the hook while it is enabled through `core.hooksPath`, an edited or non-executable hook, another git client, and an upload through the GitHub web interface or GitHub's content APIs all skip it; and an edit, committed or not, of the rule, the scan, the engine code the rule imports from `src/` or the schemas in the checkout it runs from, or a changed `node_modules`, weakens it without skipping it, since it enforces whatever those files say. It scans the commits of every pushed ref (a git notes ref's notes are files of its commits, so the content check reads them), their commit messages and headers, and the message and header of every annotated tag it pushes. The owner installs it in `.git/hooks` of every clone on the capture host before the first capture (handoff A12); no test can verify that step.",
      ]],
      ['docs/M2_DATA_SOURCE_DECISION.md', decision, [
        "**Seventh revision of 2026-09-25 (after a read-only QA of `66c19e2`, posted on pull request #3 as comment 5825350168, which ran in a session the authors' session had created).** No new reading was reported and none was made, and C2, C3 and C5 remain unmet. A review run in a session that the authors' session created, directly or through another session or agent, or by any of their agents, is not independent under handoff Gate and sequence step 1, whoever asked for it, so it is not the independent QA of step 1: this supersedes the sixth revision's statement that whether such a review counts is the owner's decision, which is kept as written; none of those reviews is the step-1 clearance of any SHA. C3, like C2, must now be current before the P0 listing as well as before each capture day, from a reading made on the day of the listing and on each capture day (§1 C3). The absence of a per-message order-entry or cancel cost carries [U] (§4), every non-empty cell of the §3 table carries its label, and the citation ledger now lists `crates/kraken-core/src/response/result.rs`, `rust/src/api/market/ws_types.rs` and the Gemini and Binance.US repositories that §3 cites (§5).",
        "- **C3, jurisdiction (blocking).** Source: the official US quick-start page, `https://support.kraken.com/articles/quick-start-for-clients-in-the-united-states`, checked on 2026-09-23 through search excerpts only (direct access refused, see the revision note): \"Kraken does not offer services to residents of New York (NY), and Maine (ME)\", with state-level restrictions on fiat transfers (IN, LA, MA, UT) and on EUR (TX, NH) [S]. Whether that list is complete is unknown [U], and the 2026-09-22 excerpts left Washington's spot status open [U]. C3 is met only when the owner confirms in writing on pull request #3, from the live page and with the date of that reading, that the host that runs the P0 listing and every capture is located in, and the person who operates it resides in, a US state the venue serves for spot (the state need not be named publicly); like C2, it must be current: it is met for the P0 listing only when the owner has confirmed or re-confirmed it in the same way, with the date of that day's reading, on the day of the listing and before it, and it stays met for a capture day only when the owner has re-confirmed it in the same way, with the date of that day's reading, before that day's capture. No geographic workaround of any kind: no VPN, proxy, remote host or third party in another jurisdiction.",
      ]],
    ];
    for (const [name, text, lines] of pinned) {
      const all = text.split('\n');
      for (const line of lines) expect(all, `${name}: ${line.slice(0, 80)}`).toContain(line);
    }
    expect(handoff).toContain("**P0, before any code (owner only, no PR, and only after the owner has met conditions C2 and C3 of M2_DATA_SOURCE_DECISION.md §1, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, because it is automated access to the venue; for P0, C2 includes the owner's answer on whether retaining the P0 payload is covered).** From the host confirmed under C3,");
  });

  it('keeps S7 routing every correction to a step 3a pull request, each PR a draft the implementer never merges, and PR-0 and PR-1 blocked at handoff', () => {
    expect(row('S7')).toMatch(/PR-1 never edits them: an error the implementer finds is reported in the PR with the assumption made, and any correction, whatever its cause, is a separate documents pull request under Gate and sequence step 3a, which PR-1 takes in before any capture\. \| /);
    expect(handoff).toMatch(/^- Each PR is a draft and is not merged by the implementer\.$/m);
    expect(prompt).toMatch(/the diff touches none of the excluded directories; each PR stays a draft\. At once after the owner merges PR-1/);
    expect(blocked).toMatch(/^- PR-0 and PR-1 cannot start: pull request #3 has not been cleared by an independent QA at an exact SHA, and the owner has not merged it \(Gate and sequence, steps 1 and 2\)\. Until it is merged, `main` has none of the contract's documents, schemas or tests\.$/m);
  });

  it('runs the P0 listing only after C2 and C3, never makes it wait for C5, in every restatement', () => {
    expect(decision).toMatch(/the P0 listing does not run until C2 and C3 are met, and nothing is captured until C2, C3 and C5 are met\./);
    expect(decision).toMatch(/\(a\) until C2 and C3 are met, the P0 listing does not run, and until C2, C3 and C5 are met, nothing is captured;/);
    expect(readme).toMatch(/The P0 listing does not run until decision conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, and nothing is captured until C2, C3 and C5 are met/);
    expect(gate).toMatch(whole("**P0 (owner only).** Only after decision conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the P0 listing, C3 from a reading made on the day of the listing (decision §1); for P0, C2 includes the owner's answer on whether retaining the P0 payload is covered (decision §1 C2)."));
    expect(handoff).toMatch(/\*\*P0, before any code \(owner only, no PR, and only after the owner has met conditions C2 and C3 of M2_DATA_SOURCE_DECISION\.md §1, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, because it is automated access to the venue;/);
    expect(prompt).toMatch(/the owner's derived statement of the P0 listing \(made only after C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, from the host confirmed under C3\)/);
    expect(prompt).toMatch(/the OWNER runs the P0 check \(only after conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, from the host confirmed under C3 and operated by the person confirmed under C3\)/);
  });

  it('names no compared path in the where column of a PR-0 or PR-1 change (N9)', () => {
    for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']) {
      const where = row(id).split('|').at(-2) ?? '';
      expect(where.trim(), id).not.toBe('');
      for (const m of where.matchAll(/`([^`]+)`/g)) {
        const path = m[1]!.replace(/\/$/, '');
        expect(COMPARED.some((c) => c === path || c.startsWith(`${path}/`)), `${id}: ${m[1]}`).toBe(false);
      }
    }
  });
});

describe('decision condition C5 gates every capture', () => {
  it('names the three readings it needs and blocks every capture until they are resolved', () => {
    const c5 = decision.slice(decision.indexOf('- **C5,'), decision.indexOf('**Alternates.**'));
    for (const item of ['`tradeIdOrdered: true`', '`tradeStreamGranularity: per_fill`', 'the 15 s liveness timeout']) expect(c5).toContain(item);
    expect(c5).toMatch(/No capture starts while C5 is unmet; the P0 listing does not depend on it/);
    expect(c5).toMatch(/this document makes that decision for no one/);
  });

  it('appears in every capture precondition: the gates of each document, A12, section 5 and the prompt', () => {
    expect(decision).toMatch(/until C2, C3 and C5 are met, nothing is captured/);
    expect(contract).toMatch(/Nothing is captured until decision conditions C2, C3 and C5 are met/);
    expect(readme).toMatch(/nothing is captured until C2, C3 and C5 are met/);
    expect(requirements).toMatch(/nothing is captured until decision condition C5 \(below\) is also met/);
    expect(gate).toMatch(/No capture of market data \(A12\) runs before decision conditions C2, C3 and C5 are met/);
    expect(row('A12')).toMatch(/and C5 \(the owner's dated live-page reading/);
    expect(row('S6')).toMatch(/both re-confirmed before the capture day, and has met condition C5/);
    expect(blocked).toMatch(/the owner has confirmed conditions C2, C3 and C5/);
    expect(blocked).toMatch(/Condition C5 is unmet/);
    expect(prompt).toMatch(/No capture \(item 6\) runs until decision condition C5 is also met/);
    expect(prompt).toMatch(/and C5 \(the owner's dated live-page reading, posted on pull request #3, of the pages decision section 4 lists, among them the trade_id wording behind tradeIdOrdered, whether each trade item is one fill \(per_fill\), and the heartbeat cadence/);
    // Every restatement names all three of decision C5's routes, and the scope is the whole section 4 reading.
    for (const text of [row('A12'), prompt]) expect(text).toMatch(/confirmed by the page, the contract corrected in a documents change under .*Gate and sequence step 3a, which counts only .*(PR-1 head).* contains and implements that correction, or the owner's written decision to capture on the stated assumption/);
    expect(decision).toMatch(/after PR-0 has landed or a substitute pair has been chosen from the P0 listing, and after C2, C3 and C5 are met\./);
    expect(decision).toMatch(/For the P0 listing it is part of C2: C2 is not met for P0 until the owner has posted that answer on pull request #3/);
    expect(gate).toMatch(/for P0, C2 includes the owner's answer on whether retaining the P0 payload is covered/);
    expect(handoff).toMatch(/because it is automated access to the venue; for P0, C2 includes the owner's answer on whether retaining the P0 payload is covered/);
    expect(decision).toMatch(/C5 is met only when both hold: each item has been read on the live page and its date recorded before the first capture; and, for three of them/);
  });

  it('requires C3, like C2, to be current before the P0 listing as well as before each capture day, in every P0 gate (N1)', () => {
    const c3 = decision.slice(decision.indexOf('- **C3, jurisdiction'), decision.indexOf('- **C4,'));
    expect(c3).toMatch(/like C2, it must be current: it is met for the P0 listing only when the owner has confirmed or re-confirmed it in the same way, with the date of that day's reading, on the day of the listing and before it, and it stays met for a capture day only when the owner has re-confirmed it in the same way, with the date of that day's reading, before that day's capture\./);
    expect(decision).toMatch(/Before the P0 listing and before each capture day, the owner confirms on pull request #3, with the date of that reading, that the terms and uses the attested clearance relied on are unchanged/);
    expect(gate).toMatch(/3\. \*\*P0 \(owner only\)\.\*\* Only after decision conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the P0 listing, C3 from a reading made on the day of the listing \(decision §1\)/);
    expect(handoff).toMatch(/only after the owner has met conditions C2 and C3 of M2_DATA_SOURCE_DECISION\.md §1, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, because it is automated access to the venue/);
    expect(prompt).toMatch(/made only after C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, from the host confirmed under C3/);
    expect(prompt).toMatch(/runs the P0 check \(only after conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing, from the host confirmed under C3/);
    expect(contract).toMatch(/runs only after decision conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing \(decision §1\)/);
    expect(readme).toMatch(/The P0 listing does not run until decision conditions C2 and C3 are met, each confirmed or re-confirmed with the date of that reading before the listing, C3 from a reading made on the day of the listing/);
    // A capture day still needs that day's own reading: no wording lets one confirmation made before the P0 listing
    // serve every later capture day.
    expect(decision).not.toMatch(/before the P0 listing and before that day's capture respectively/);
    expect(c3.match(/with the date of that day's reading, before that day's capture/g)).toHaveLength(1);
  });

  it('leaves no sentence or table row that gates a capture, A12 or the real session on C2 or C3 without C5', () => {
    for (const [name, text] of docs) {
      // Sentences end at a period followed by a space (or a line end); each table row is its own unit.
      const units = text.split('\n').flatMap((line) => (line.startsWith('|') ? [line] : line.split(/(?<=\.)\s+/)));
      const gates = units.filter((u) => /(captur|A12|real-session|real session)/i.test(u) && /(only after|until|before|after|once|when|nothing is captured|no capture)/i.test(u) && /\bC[23]\b/.test(u));
      const alone = gates.filter((u) => !/\bC5\b/.test(u) && !NOT_GATES.some((prefix) => u.startsWith(prefix)));
      expect(alone, name).toEqual([]);
    }
  });

  it('keeps its list of units that mention a capture and C2 or C3 without being a capture gate exact: each is still there', () => {
    const all = docs.map(([, text]) => text).join('\n');
    for (const prefix of NOT_GATES) expect(all, prefix).toContain(prefix);
  });
});

describe('independent QA of one exact commit (handoff, Gate and sequence, step 1)', () => {
  it('clears a full SHA that the reviewer verifies is the live head, and no other', () => {
    expect(gate).toMatch(/one full 40-character commit SHA, called X here/);
    expect(gate).toMatch(/verifies, when the QA starts and again when it reports, that X is the live head of pull request #3/);
    expect(gate).toMatch(/Any later push to pull request #3 voids it, and no earlier QA or audit transfers to another SHA/);
    expect(gate).toMatch(/never whichever QA request or comment is the latest/);
  });

  it('defines independence by authorship of the content, excluding the authors\' session, its agents and the implementer, in the gate and the prompt alike', () => {
    expect(gate).toMatch(/Independent means a reviewer who authored neither X, nor any other commit of pull request #3, nor any of its self-audits, and who is not an agent or session run or created by a session that did/);
    expect(gate).toMatch(/the authors' session \(`https:\/\/claude\.ai\/code\/session_012vfVeZ81tBGEeg2YZGvWVE`, named in the `Claude-Session` trailer of pull request #3's commits\), every session, subagent or agent it created or ran, directly or through another session or agent, and the implementer are not independent, whoever asked for the review/);
    expect(gate).toMatch(/Authored means wrote or generated the content, whatever a commit's git author field says/);
    expect(prompt).toMatch(/by a reviewer who authored \(wrote or generated, whatever the git author field says\) neither X nor any other commit or self-audit of pull request #3 and is not an agent or session run or created by a session that did \(the authors' session, https:\/\/claude\.ai\/code\/session_012vfVeZ81tBGEeg2YZGvWVE, every session, subagent or agent it created or ran, directly or through another session or agent, and you, the implementer, are not independent\)/);
    expect(prompt).toMatch(/verified that X was the live head of pull request #3 when the QA started and again when it reported/);
  });

  it('no longer points any gate at a QA request comment', () => {
    for (const [name, text] of allDocs) {
      expect(text, name).not.toMatch(/commit named in the pull request's QA request/);
      expect(text, name).not.toMatch(/latest QA request/i);
    }
  });
});

describe('the status of reviews run in sessions the authors\' session created (N11)', () => {
  it('states in a dated note of the contract and of the decision that such a review is not the step-1 QA, superseding the sixth revision and keeping it as written', () => {
    for (const [name, text] of [['docs/M2_DATA_CONTRACT.md', contract], ['docs/M2_DATA_SOURCE_DECISION.md', decision]] as [string, string][]) {
      expect(text, name).toMatch(/2026-09-25 \(after a read-only QA of `66c19e2`, posted on pull request #3 as comment 5825350168, which ran in a session the authors' session had created\)[^\n]*a review run in a session that the authors' session created, directly or through another session or agent, or by any of their agents, is not independent under handoff Gate and sequence step 1, whoever asked for it, so it is not the independent QA of step 1[^\n]*supersedes the sixth revision's statement that whether such a review counts is the owner's decision/i);
      expect(text, name).toMatch(/none of those reviews is the step-1 clearance of any SHA/);
    }
    // The historical notes are kept as written; only the later note supersedes them.
    expect(contract).toMatch(/so whether it counts as the independent QA of handoff Gate and sequence step 1 is the owner's decision\)/);
    expect(decision).toMatch(/so whether it counts as the independent QA is the owner's decision\)/);
    expect(contract.indexOf('Ninth revision 2026-09-25')).toBeGreaterThan(contract.indexOf('Eighth revision 2026-09-24'));
    expect(decision.indexOf('**Seventh revision of 2026-09-25')).toBeGreaterThan(decision.indexOf('**Sixth revision of 2026-09-24'));
    expect(decision.indexOf('**Seventh revision of 2026-09-25')).toBeLessThan(decision.indexOf('## 1. Decision'));
  });
});

describe('decision document labels and citation ledger (N13)', () => {
  const ledger = decision.slice(decision.indexOf('## 5. Citation ledger'));
  it('labels every absence of documentation and every non-empty cell of the candidate table', () => {
    expect(decision).not.toMatch(/none was found; not verified\)/);
    expect(decision).toMatch(/order-entry or cancel\) cost exists \(none was found; not verified \[U\]\)/);
    const lines = decision.split('\n');
    const head = lines.findIndex((l) => l.startsWith('| candidate | US availability |'));
    expect(head).toBeGreaterThanOrEqual(0);
    const cols = lines[head]!.split('|').slice(1, -1).map((s) => s.trim());
    const unlabeled: string[] = [];
    for (let i = head + 2; lines[i]?.startsWith('|'); i++) {
      const cells = lines[i]!.split('|').slice(1, -1).map((s) => s.trim());
      expect(cells.length, lines[i]).toBe(cols.length);
      cells.forEach((cell, j) => {
        if (j === 0 || cols[j] === 'verdict' || cell === '') return;
        if (!/\[(?:R|S|T|U|O)\b[^\]]*\]/.test(cell)) unlabeled.push(`${cells[0]} / ${cols[j]}: ${cell}`);
      });
    }
    expect(unlabeled).toEqual([]);
  });

  it('lists in the citation ledger every file and repository the documents cite from a venue repository', () => {
    const expand = (p: string): string[] => {
      const m = /^(.*)\{([^}]+)\}(.*)$/.exec(p);
      return m ? m[2]!.split(',').map((x) => `${m[1]}${x}${m[3]}`) : [p];
    };
    const ledgerPaths = [...ledger.matchAll(/`([^`\s]+\.(?:rs|go|md|py))(?::[0-9][0-9, -]*)?`/g)].flatMap((m) => expand(m[1]!));
    const internal = /^(?:docs\/|schemas\/|tests\/|src\/(?:core|market|engine|cli|ledger|analysis|capture|normalize|scenarios)|README\.md$|[A-Z_]+\.md$|M2_)/;
    const cited = new Set<string>();
    for (const [, text] of docs) {
      for (const m of text.matchAll(/`(?:(?:api-go|kraken-api-sdk|kraken-cli)\/)?([^`\s]+\.(?:rs|go|md|py))(?::[0-9][0-9, -]*)?`/g)) {
        const p = m[1]!;
        if (internal.test(p) && !/^src\/commands\//.test(p)) continue;
        for (const q of expand(p)) cited.add(q);
      }
    }
    const missing = [...cited].filter((p) => !ledgerPaths.some((l) => l === p || l.endsWith(`/${p}`)));
    expect(missing).toEqual([]);
    for (const m of decision.matchAll(/\[R `([a-z0-9-]+\/[a-z0-9._-]+)` `([0-9a-f]{12})`/g)) {
      expect(ledger, m[1]).toMatch(new RegExp(`\`${m[1]!.replace(/[.]/g, '\\.')}\`[^\\n]*\\| \`${m[2]}\``));
    }
  });
});

describe('the contract states what the reference checker and the A10 content check do (N2, N3, N4, N14, D1)', () => {
  it('names the record of every refusal the reference reports and the exact reading of a probe\'s unixtime', () => {
    expect(contract).toMatch(/for R10 the offending record, except that for records after `manifest_end`, and for a last socket with no terminal record \(a condition of the whole stream, step \(3\) above\), it is the `manifest_end` record\./);
    expect(contract).toMatch(/or a last socket with no terminal record when the stream ends \(at the `manifest_end` record, §5\.10\)/);
    expect(contract).toMatch(/whose `result\.unixtime` is a JSON number whose exact value, read from its digits and never through a float, is an integer of magnitude at most 2\^53 - 1/);
    expect(contract).not.toMatch(/`result\.unixtime` is an integer;/);
  });

  it('records a later snapshot\'s status change in venueStatus without refusing it, in the contract and the fixture schema', () => {
    expect(contract).toMatch(/A later snapshot's `status` for the pair is not compared: it refuses nothing and cuts nothing; a change it shows is recorded in `venueStatus` \(§8\.4\)\./);
    expect(contract).toMatch(/and every `instrument` update, or later snapshot on the same socket, that changes this pair's `status`, `source: "instrument"`\)/);
    expect(contract).toMatch(/A later `instrument` `update` frame, or a later `snapshot` frame on the same socket, that changes this pair's `status` is recorded in `venueStatus`/);
    const fixtureSchema = JSON.parse(read('schemas/fixture.v2.schema.json')) as { $defs: { capture: { properties: { venueStatus: { description: string } } } } };
    expect(fixtureSchema.$defs.capture.properties.venueStatus.description).toMatch(/instrument updates, or later snapshots on the same socket, that change this pair's status/);
  });

  it('defines the content check\'s lines as the code does, and claims .gitignore only for the lower-case capture directories', () => {
    expect(contract).toMatch(/no line of it \(a line ends at CR LF, LF or CR\), and no part of a line between VT, FF, NEL, U\+2028 and U\+2029, trimmed of white space, of control characters \(Unicode Cc, such as the record separator of a JSON text sequence\), of format characters \(Unicode Cf, such as a zero-width space or a byte order mark\) and of marks \(Unicode M, such as a combining grapheme joiner or a variation selector\) at both ends, may be a JSON object that is a raw capture record/);
    expect(contract).toMatch(/each line is tried whole as well as in parts, since JSON permits NEL, U\+2028 and U\+2029 unescaped inside a string, so a record whose string values hold them is still found/);
    expect(contract).toMatch(/its first line, after any leading white space, which git-lfs skips, is `version https:\/\/git-lfs\.github\.com\/spec\/v1`/);
    expect(contract).not.toMatch(/lines split at CR LF, LF, CR, VT, FF, NEL, U\+2028 and U\+2029/);
    // D6 and D4: the forms the check also finds, what it still does not see, and nested records in a recorded fixture.
    expect(contract).toMatch(/or a JSON array with one among its elements, as it stands or after removing markdown block-quote markers \(`>`\) at its start, then a trailer token \(a letter or digit, then letters, digits and hyphens, followed by a colon and white space, `Raw-Record: ` for example\), then one trailing comma/);
    expect(contract).toMatch(/The other way round, since a raw capture record is recognized by its `type` or its two clock fields, an unrelated JSON object whose `type` is one of the record types of `schemas\/capture-record\.v1\.schema\.json`, such as `ping`, `message`, `note`, `subscribe` or `probe` \(a server-sent-events `data:` line, for example\), is refused in any of these forms as well; such a sample is written with its `type` changed\./);
    expect(contract).toMatch(/embedded in other text on its line in any other way \(a markdown table cell, a list marker, a log or `grep` prefix, a diff's `\+`, a code statement, or inside another object of a one-line JSON text\)/);
    expect(contract).toMatch(/or nested at any depth under any key of a recorded fixture's header or event;/);
    expect(contract).toMatch(/PR-1's extension below refuses an undeclared key on an event, but its byte-for-byte check does not close the header, which the engine keeps as parsed/);
    expect(row('A10')).toMatch(/schema-valid events and no raw capture record nested in its header or events/);
  });
});

describe('no document presents a layer, a check or a list of residual routes as complete', () => {
  const hook = read('.githooks/pre-push');

  it('states the lists of what no A10 layer sees and what the report checks cannot rule out as not exhaustive', () => {
    expect(contract).toMatch(/What no layer sees includes at least the following \(the list is not exhaustive, and no layer, nor the three together, is claimed to catch every way recorded data can reach the repository or GitHub\):/);
    expect(contract).toMatch(/cannot rule out is a recorded value encoded into any of the report's constrained values, in ways that include at least these \(the list is not exhaustive\):/);
    expect(contract).toMatch(/The cross-reference checks test consistency, not truth\./);
    expect(blocked).toMatch(/contract §6\.5, which lists further routes no layer sees; that list is not exhaustive either/);
  });

  it('does not claim that .gitignore keeps every letter case, or every way in, out of a commit', () => {
    expect(contract).toMatch(/`\.gitignore` ignores them at any depth under their lower-case names only, and another letter case only where git's `core\.ignorecase` is set/);
    expect(contract).toMatch(/it keeps a file there out of a plain `git add`, not out of a commit, since `git add -f`, `git mv`, `git apply --index`, `git am` and a `\.gitignore` negation such as `!captures\/` in a subdirectory all stage one/);
    for (const [name, text] of [...allDocs, ['tests/jsonl-policy.ts', read('tests/jsonl-policy.ts')] as [string, string]]) {
      expect(text, name).not.toMatch(/tracked only by force|enters Git only by force/);
    }
  });

  it('does not limit the commits CI never scans after a force-push to those removed before a pull request is opened', () => {
    expect(contract).toMatch(/and neither may be commits removed that way from an open pull request's branch or from `main` before a run has scanned them: when no run starts for their push/);
    expect(contract).toMatch(/a later run scans only its own range, which no longer contains them/);
    expect(contract).toMatch(/a pull request's next run rescans its whole `base\.\.head`, which no longer holds commits force-pushed away before it/);
    expect(contract).not.toMatch(/before a pull request is opened are never scanned, and GitHub may keep them retrievable by their SHA/);
  });

  it('says the hook enforces the rule, scan, engine code and schemas of its working tree, and that the cmp check covers the hook file only', () => {
    const flat = hook.replace(/\n# ?/g, ' ');
    expect(flat).toMatch(/an edit, committed or not, of the rule, the scan, the engine code or the schemas in the checkout it runs from, or a changed node_modules, weakens it without skipping it/);
    expect(contract).toMatch(/weakens it without skipping it, since it enforces whatever those files say/);
    expect(contract).toMatch(/and the hook enforces those files as they stand in the working tree it runs from, an uncommitted edit included/);
    expect(contract).toMatch(/that compares the hook copy only, not the rule, the scan, the engine code or the schemas it runs from the working tree, so at the same times the owner also checks that `git status --porcelain` prints nothing \(neither check covers `node_modules`, which `npm ci` reinstalls from the lock file, and `git status` sees only uncommitted changes: a change committed on the capture host's branch shows only in that branch's diff against its cleared baselines, handoff Gate and sequence step 2\)\./);
    expect(row('A12')).toMatch(/and `git status --porcelain` printing nothing from a checkout of the current branch before the first capture and before each push from that host \(the `cmp` check compares the hook copy only/);
    expect(prompt).toMatch(/and git status --porcelain printing nothing before the first capture and before each push from that host/);
    expect(contract).toMatch(/from a checkout of the current branch before the first capture and before each push from the capture host \(handoff A12\)/);
    for (const [name, text] of allDocs) expect(text, name).not.toMatch(/git status --porcelain -- /);
  });

  it('calls the hook and CI prevention only in the negative, and drops the closed-report overclaim', () => {
    for (const [name, text] of [...allDocs, ['.githooks/pre-push', hook] as [string, string]]) {
      for (const m of text.matchAll(/complete prevention/g)) {
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        expect(before, name).toMatch(/(not a guarantee and not|none of the three layers is|opt-in and not) $/);
      }
      expect(text, name).not.toMatch(/so the report carries nothing else/);
    }
    expect(contract).toMatch(/none of the three layers is complete prevention/);
    expect(hook).toMatch(/It is a local, bypassable control, not a guarantee and not complete prevention/);
  });
});
