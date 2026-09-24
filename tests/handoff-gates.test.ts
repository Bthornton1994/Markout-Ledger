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
  it('states that main lacks the contract until the owner merges pull request #3, and orders the five steps', () => {
    expect(gate).toMatch(/exist only on pull request #3's branch until the owner merges it: `main` has none of them/);
    const steps = ['Independent QA of one exact commit', 'The owner merges pull request #3 at X', 'P0 (owner only)', '**PR-0**', '**PR-1**'];
    const at = steps.map((s) => gate.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('checks the merge by ancestry (or, after a squash, by tree) and never lets the implementer merge', () => {
    expect(gate).toMatch(/git merge-base --is-ancestor X origin\/main/);
    expect(gate).toMatch(/git diff --quiet X <the merge commit on main>/);
    expect(gate).toMatch(/Only the owner merges; the implementer never merges and never pushes to pull request #3/);
  });

  it('branches PR-0 and PR-1 only from a main that passed that check, in the prompt too', () => {
    expect(prompt).toMatch(/grok\/m2-precision-migration created from origin\/main after the check of \(2\) above/);
    expect(prompt).toMatch(/grok\/m2-recorded-replay created from origin\/main after PR-0 is merged by the owner, or, when .* from an origin\/main that passes the check of \(2\) above/);
    expect(prompt).toMatch(/git merge-base --is-ancestor X origin\/main succeeds/);
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
    expect(blocked).toMatch(/the owner has confirmed conditions C2, C3 and C5/);
    expect(blocked).toMatch(/Condition C5 is unmet/);
    expect(prompt).toMatch(/No capture \(item 6\) runs until decision condition C5 is also met/);
    expect(prompt).toMatch(/and C5 \(the owner's dated live-page reading, posted on pull request #3, of the trade_id wording behind tradeIdOrdered, whether each trade item is one fill \(per_fill\), and the heartbeat cadence/);
  });

  it('leaves no sentence that gates a capture on C2 and C3 alone', () => {
    for (const [name, text] of docs) {
      const sentences = text.split(/(?<=[.;])\s+/);
      const alone = sentences.filter((s) => /(nothing is captured|no capture)/i.test(s) && /C2/.test(s) && !/C5/.test(s));
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

  it('defines independence by authorship, excluding the authors\' session, its agents and the implementer', () => {
    expect(gate).toMatch(/Independent means a reviewer who authored neither X nor any commit of pull request #3, nor any of its self-audits/);
    expect(gate).toMatch(/the authors' session, its subagents and the implementer are not independent/);
    expect(prompt).toMatch(/by a reviewer who authored none of pull request #3's commits and none of its self-audits/);
  });

  it('no longer points any gate at a QA request comment', () => {
    for (const [name, text] of docs) {
      expect(text, name).not.toMatch(/commit named in the pull request's QA request/);
      expect(text, name).not.toMatch(/latest QA request/i);
    }
  });
});
