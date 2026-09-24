// Acceptance cases for the gates the owner and the implementer read before any build or capture (docs/M2_GROK_HANDOFF.md,
// "Gate and sequence"; docs/M2_DATA_SOURCE_DECISION.md section 1): the order from pull request #3 to PR-0 and PR-1, the
// C5 capture gate, and the independent QA of one exact commit. These are text checks: they fail when a document loses
// or contradicts a gate, not when someone ignores one.
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
const docs: [string, string][] = [
  ['README.md', readme],
  ['docs/DATA_REQUIREMENTS.md', requirements],
  ['docs/M2_DATA_CONTRACT.md', contract],
  ['docs/M2_DATA_SOURCE_DECISION.md', decision],
  ['docs/M2_GROK_HANDOFF.md', handoff],
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

  it('routes a substitute pair or a C5 correction through its own cleared documents pull request, never through PR-1', () => {
    expect(gate).toMatch(/3a\. \*\*A documents change after the merge, when one is needed\.\*\* A substitute pair .* is its own documents pull request, cleared under step 1's rules applied to that pull request/);
    expect(gate).toMatch(/The implementer never makes these changes inside PR-0 or PR-1/);
    expect(row('S7')).toMatch(/Gate and sequence step 3a, never part of PR-1/);
    expect(prompt).toMatch(/never change the symbol or the contract yourself/);
  });

  it('branches PR-0 and PR-1 only from a main that passed that check, in the prompt too', () => {
    expect(prompt).toMatch(/grok\/m2-precision-migration created from origin\/main after the check of \(2\) above/);
    expect(prompt).toMatch(/grok\/m2-recorded-replay created from origin\/main after PR-0 is merged by the owner, or, when .* from an origin\/main that passes the check of \(2\) above/);
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
    for (const text of [row('A12'), prompt]) expect(text).toMatch(/confirmed by the page, the contract corrected in a documents change under .*Gate and sequence step 3a, or the owner's written decision to capture on the stated assumption/);
    expect(decision).toMatch(/C5 is met only when both hold: each item has been read on the live page and its date recorded before the first capture; and, for three of them/);
  });

  it('leaves no sentence or table row that gates a capture, A12 or the real session on C2 or C3 without C5', () => {
    for (const [name, text] of docs) {
      // Sentences end at a period followed by a space (or a line end); each table row is its own unit.
      const units = text.split('\n').flatMap((line) => (line.startsWith('|') ? [line] : line.split(/(?<=\.)\s+/)));
      const gates = units.filter((u) => /(captur|A12|real-session|real session)/i.test(u) && /(only after|until|before|nothing is captured|no capture)/i.test(u) && /\bC[23]\b/.test(u));
      // Not capture gates: a unit about the P0 listing alone (gated on C2 and C3 only, by design), and a unit that
      // defines how C2 or C3 is met or re-confirmed.
      const defining = /(re-confirm|is met only when|stays met|confirms on pull request #3)/;
      // Also not capture gates: the A10 row (what may be committed) and the prompt's start gate for any work, whose
      // capture clause is its own sentence ("No capture (item 6) runs until decision condition C5 is also met").
      const other = (u: string): boolean => u.startsWith('| A10 |') || u.startsWith('Do not start anything until the owner confirms all of the following');
      const alone = gates.filter((u) => !/\bC5\b/.test(u) && !defining.test(u) && !other(u) && !/^[^.]*\bP0\b[^.]*$/.test(u.replace(/capture/gi, '')));
      expect(alone, name).toEqual([]);
    }
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
