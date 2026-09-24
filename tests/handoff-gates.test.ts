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
    expect(gate).toMatch(/PR-0 and PR-1 never change these paths: if a merged PR-0 has changed any of them, the implementer stops and reports/);
    expect(row('PA6')).toMatch(/never a path that Gate and sequence step 2 compares/);
  });

  it('needs no change to a compared path from PR-1: engines.node is already the Node version S1 relies on', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { engines?: { node: string } }> };
    expect(pkg.engines.node).toBe('>=22.4');
    expect(lock.packages['']?.engines?.node).toBe('>=22.4');
    expect(row('S1')).toMatch(/`engines\.node` is already `>=22\.4`, set by pull request #3; PR-1 changes no path Gate and sequence step 2 compares, `package\.json` included/);
    expect(prompt).toMatch(/engines\.node is already >=22\.4, set by pull request #3; you change no path the check of \(2\) above compares, package\.json included/);
    for (const [name, text] of docs) expect(text, name).not.toMatch(/set `?engines\.node`? to/);
  });

  it('routes every contract change after the merge through its own cleared documents pull request, never through PR-0 or PR-1', () => {
    expect(gate).toMatch(/3a\. \*\*A documents change after the merge, when one is needed\.\*\* Any change to the contract's documents or schemas after pull request #3 merges .* is its own documents pull request, cleared under step 1's rules applied to that pull request/);
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
