// Acceptance cases for the gates the owner and the implementer read before any build or capture (docs/M2_GROK_HANDOFF.md,
// "Gate and sequence"; docs/M2_DATA_SOURCE_DECISION.md section 1): the order from pull request #3 to PR-0 and PR-1, the
// C5 capture gate, the independent QA of one exact commit, and the limits of the A10 layers and of the normalize-report
// checks, which no document may present as complete. These are text checks: they fail when a document loses or
// contradicts a gate, not when someone ignores one.
import { readFileSync } from 'node:fs';
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
    const expected = ['docs/M2_DATA_CONTRACT.md', 'docs/M2_DATA_SOURCE_DECISION.md', 'docs/M2_EVALUATION_PROTOCOL.md', 'docs/M2_GROK_HANDOFF.md', 'schemas', 'tests/jsonl-policy.ts', 'tests/a10-history-cli.ts', 'tests/repository-jsonl.test.ts', 'tests/capture-structure.ts', 'tests/capture-structure.test.ts', 'tests/handoff-gates.test.ts', 'tests/schemas.test.ts', '.githooks/pre-push', '.github/workflows/ci.yml', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];
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
    expect(gate).toMatch(/repeats step 2's content check on that `main` commit against that change's cleared SHA/);
    expect(row('A10')).toMatch(/PR-1 extends the recorded kind, in `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts` \(the one change to a compared path that Gate and sequence step 2 allows PR-1\)/);
    expect(handoff).toMatch(/the PR description lists every change to `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts`, the only compared paths PR-1 changes and only for the A10 extension \(Gate and sequence step 2\), for the owner's review; `tests\/a10-history-cli\.ts`, `\.githooks\/pre-push` and `\.github\/workflows\/ci\.yml` are unchanged/);
    expect(prompt).toMatch(/extend it as A10 says, in tests\/jsonl-policy\.ts and tests\/repository-jsonl\.test\.ts only, adding refusals and removing none \(the only change you make to a path the check of \(2\) compares\)/);
    expect(contract).toMatch(/PR-1 extends kind \(2\), in `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts` \(the one change to a compared path that handoff Gate and sequence step 2 allows PR-1\)/);
    // The wording that asked PR-1 to change other compared paths, or no compared path at all, is gone everywhere.
    for (const [name, text] of docs) {
      expect(text, name).not.toMatch(/PR-0 and PR-1 never change these paths/);
      expect(text, name).not.toMatch(/lists every change to `tests\/jsonl-policy\.ts`, `tests\/a10-history-cli\.ts`/);
    }
  });

  it('defines the exact-SHA QA that clears PR-1 with step 1\'s checks, and names its cleared SHA as the baseline once PR-1 has merged (Q1)', () => {
    const step5 = gate.slice(gate.indexOf('5. **PR-1**'));
    expect(step5).toMatch(/PR-1 is cleared the way step 1 clears pull request #3: a read-only QA clears one full 40-character commit SHA of PR-1, called Y here/);
    expect(step5).toMatch(/the reviewer verifies, when the QA starts and again when it reports, that Y is the live head of PR-1, and says so in the report/);
    expect(step5).toMatch(/having authored neither Y, nor any other commit of PR-1, nor any of its self-audits, and not being an agent run by a session that did \(the implementer, its session and its agents are not independent\)/);
    expect(step5).toMatch(/any later push to PR-1 voids the clearance, and no earlier QA transfers to another SHA/);
    expect(step5).toMatch(/The owner merges PR-1 only while its head is Y, checked as step 2 checks X \(identity: PR-1 is merged and its last commit is Y\)/);
    expect(step5).toMatch(/Once PR-1 has merged, step 2's content check compares `tests\/jsonl-policy\.ts` and `tests\/repository-jsonl\.test\.ts` with Y and every other compared path with X, or with the cleared SHA of the last step 3a change that changed it/);
    expect(prompt).toMatch(/cleared by an exact-SHA QA under handoff Gate and sequence step 5 \(the checks and independence of step 1 applied to PR-1: a reviewer who is not you, your session or your agents verifies that the SHA it clears is PR-1's live head when the QA starts and when it reports, and any later push voids it\) before the owner merges it while its head is that SHA/);
    // The undefined phrases the re-audit of e8764f1 found (Q1) are gone.
    for (const [name, text] of docs) {
      expect(text, name).not.toMatch(/PR-1's own exact-SHA QA/);
      expect(text, name).not.toMatch(/PR-1's cleared SHA/);
    }
  });

  it('routes every change to a schema, its examples or tests/schemas.test.ts through its own step 3a pull request with its own exact-SHA QA, never PR-1 (Q2)', () => {
    expect(gate).toMatch(/Any change to the contract's documents, to a schema under `schemas\/`, to its examples under `schemas\/examples\/` or to `tests\/schemas\.test\.ts` after pull request #3 merges/);
    expect(gate).toMatch(/is its own documents pull request, cleared under step 1's rules applied to that pull request/);
    expect(row('S7')).toMatch(/the contract documents \(`docs\/M2_\*\.md`\), `schemas\/` \(the schemas and `schemas\/examples\/`\) and `tests\/schemas\.test\.ts` stay the source of truth and PR-1 never edits them/);
    expect(handoff).toMatch(/PR-1 changes no schema, no file under `schemas\/examples\/` and not `tests\/schemas\.test\.ts` \(S7, Gate and sequence step 2\): a change to any of the three JSON Schemas is its own documents pull request under Gate and sequence step 3a, with its own exact-SHA QA, and updates `schemas\/examples\/` and `tests\/schemas\.test\.ts` in that pull request/);
    expect(prompt).toMatch(/you change no schema, no file under schemas\/examples and not tests\/schemas\.test\.ts: a schema change, with its examples and tests\/schemas\.test\.ts, is its own documents pull request under handoff Gate and sequence step 3a with its own exact-SHA QA, never part of PR-1/);
    // The wording that put a schema change inside PR-1 (Q2) is gone.
    for (const [name, text] of docs) {
      expect(text, name).not.toMatch(/`tests\/schemas\.test\.ts` in the same PR/);
      expect(text, name).not.toMatch(/updating schemas\/examples and tests\/schemas\.test\.ts with any schema change/);
    }
  });

  it('needs no change to a compared path from PR-1: engines.node is already the Node version S1 relies on', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { engines?: { node: string } }> };
    expect(pkg.engines.node).toBe('>=22.4');
    expect(lock.packages['']?.engines?.node).toBe('>=22.4');
    expect(row('S1')).toMatch(/`engines\.node` is already `>=22\.4`, set by pull request #3; PR-1 changes no path Gate and sequence step 2 compares, `package\.json` included, other than the A10 extension step 2 allows/);
    expect(prompt).toMatch(/engines\.node is already >=22\.4, set by pull request #3; you change no path the check of \(2\) above compares, package\.json included, except the A10 extension of item 5/);
    for (const [name, text] of docs) expect(text, name).not.toMatch(/set `?engines\.node`? to/);
  });

  it('routes every contract change after the merge through its own cleared documents pull request, never through PR-0 or PR-1', () => {
    expect(gate).toMatch(/3a\. \*\*A documents change after the merge, when one is needed\.\*\* Any change to the contract's documents, to a schema under `schemas\/`, to its examples under `schemas\/examples\/` or to `tests\/schemas\.test\.ts` after pull request #3 merges .* is its own documents pull request, cleared under step 1's rules applied to that pull request/);
    expect(gate).toMatch(/The implementer never makes these changes inside PR-0 or PR-1/);
    expect(gate).toMatch(/A step 3a change merged after PR-1 has branched is taken into PR-1 before any capture/);
    expect(row('S7')).toMatch(/PR-1 never edits them/);
    expect(row('S7')).not.toMatch(/edit them only to correct an error/);
    expect(prompt).toMatch(/never change the symbol or the contract yourself/);
  });

  it('branches PR-0 and PR-1 only from a main that passed that check, in the prompt too', () => {
    expect(prompt).toMatch(/grok\/m2-precision-migration created from origin\/main after the check of \(2\) above/);
    expect(prompt).toMatch(/grok\/m2-recorded-replay created from an origin\/main that passes the check of \(2\) above .* and contains PR-0 as the owner merged it, or, when .* contains that change; if a merged PR-0 changed any of the paths that check compares, stop and report/);
    expect(gate).toMatch(/5\. \*\*PR-1\*\*, on a branch created from a `main` that passes step 2's checks/);
    expect(prompt).toMatch(/identity, pull request #3 is merged and its last commit is X as GitHub shows it \(git merge-base --is-ancestor X origin\/main alone is not enough\); and content, git diff --quiet X <the commit you branch from> --/);
    // The old wording, which branched from a main without the contract, is gone everywhere.
    for (const [name, text] of docs) expect(text, name).not.toMatch(/branch named grok\/m2-[a-z-]+ from main\b/);
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
    expect(gate).toMatch(/Independent means a reviewer who authored neither X, nor any other commit of pull request #3, nor any of its self-audits, and who is not an agent run by a session that did/);
    expect(gate).toMatch(/the authors' session, its subagents and the implementer are not independent/);
    expect(gate).toMatch(/Authored means wrote or generated the content, whatever a commit's git author field says/);
    expect(prompt).toMatch(/by a reviewer who authored \(wrote or generated, whatever the git author field says\) neither X nor any other commit or self-audit of pull request #3 and is not an agent run by a session that did \(the authors' session, its subagents and you, the implementer, are not independent\)/);
    expect(prompt).toMatch(/verified that X was the live head of pull request #3 when the QA started and again when it reported/);
  });

  it('no longer points any gate at a QA request comment', () => {
    for (const [name, text] of docs) {
      expect(text, name).not.toMatch(/commit named in the pull request's QA request/);
      expect(text, name).not.toMatch(/latest QA request/i);
    }
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

  it('calls the hook and CI prevention only in the negative, and drops the closed-report overclaim', () => {
    for (const [name, text] of [...docs, ['.githooks/pre-push', hook] as [string, string]]) {
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
