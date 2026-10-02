// Locks the offline deployment/rollback requirements doc to blanks and to recorded git facts, and the rollback, release
// prep and packet documents to the v1 scope (C2, C3, and C5 OUT OF SCOPE for v1, not passed; capture and P0 not part of v1).
// A filled target, a filled C2/C3/C5 attestation, a dropped v1 sentence, or a dropped recorded SHA fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PR3 = '890637815bb7370f75695dc20906eb12e9e289f6';
const PR4 = '9d89f9f2ba785856e0753c4ed2857a2c26b2394f';
const PR5 = '758defc624412666d4dea33bf76a705b6a0f7c52';
const PR6 = '3477f1da4b36c4291ae4e3bdeac7810a1312c2bb';

describe('deployment and rollback requirements stay decision-ready and blank', () => {
  const ops = read('docs/DEPLOYMENT_ROLLBACK.md');

  it('names no deploy host and leaves the target, the rollback action, and the known-good SHA blank', () => {
    expect(ops).toMatch(/This document names no deploy host\./);
    expect(ops).toMatch(/\| Target identifier \| ________ \|/);
    expect(ops).toMatch(/\| Previous known-good SHA \| ________ \|/);
    expect(ops).toMatch(/\| Control-plane action \| ________ \|/);
    expect(ops).toMatch(/does not define an executable production rollback/);
    expect(ops).not.toMatch(/production-ready/);
    expect(ops).not.toMatch(/https?:\/\//);
    expect(ops).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    for (const banned of ['vercel', 'fly.io', 'amazonaws', 'kubernetes', 'heroku', 'render.com', 'digitalocean']) {
      expect(ops.toLowerCase(), banned).not.toContain(banned);
    }
  });

  it('records the pull request #5 merge as history and not as a chosen production deploy', () => {
    expect(ops).toContain(PR5);
    expect(ops).toMatch(/That SHA is not a chosen production deploy\./);
  });

  it('records C2, C3, and C5 OUT OF SCOPE for v1, not passed, and leaves their assertion fields blank', () => {
    expect(ops).toContain('For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED).');
    expect(ops).toMatch(/\| C2 \| ________ \|/);
    expect(ops).toMatch(/\| C3 \| ________ \|/);
    expect(ops).toMatch(/\| C5 \| ________ \|/);
    expect(ops).not.toMatch(/\bC[235] is met\b/);
    expect(ops).not.toMatch(/\bC[235] (?:is |has |has been |was )?passed\b/i);
  });

  it('keeps capture behind C2, C3, and C5, leaves capture and P0 out of v1, and describes only the offline synthetic replay repeat', () => {
    expect(ops).toMatch(/Capture and P0 are not part of v1\./);
    expect(ops).toMatch(/Nothing is captured until C2, C3, and C5 are met/);
    expect(ops).toMatch(/npm run demo/);
    expect(ops).toMatch(/tests\/engine\.test\.ts/);
    expect(ops).toMatch(/no_trade\.ledger\.jsonl/);
    expect(ops).toMatch(/unsteered\.ledger\.jsonl/);
    expect(ops).toMatch(/steered\.ledger\.jsonl/);
  });
});

describe('release prep records the known main commits and still stops P0 and capture', () => {
  const prep = read('docs/RELEASE_PREP.md');

  it('records pull requests #3, #4, #5, and #6 and the verified Actions runs', () => {
    expect(prep).toContain(PR3);
    expect(prep).toContain(PR4);
    expect(prep).toContain(PR5);
    expect(prep).toContain(PR6);
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36214977668');
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36215785277');
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36266694661');
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36268777940');
    expect(prep).toMatch(/\[DEPLOYMENT_ROLLBACK\.md\]\(DEPLOYMENT_ROLLBACK\.md\)/);
    expect(prep).not.toMatch(/The sole git parent of the `main` tip is/);
  });

  it('records the pull request #6 merge as the only recorded tip', () => {
    expect(prep).toContain(`This file records \`main\` through the pull request #6 merge \`${PR6}\`.`);
    expect(prep).toContain('A commit after the pull request #6 merge is not described here.');
    expect(prep.match(/\(recorded tip\)/g)).toEqual(['(recorded tip)']);
    expect(prep.match(/tip recorded here/g)).toEqual(['tip recorded here']);
    expect(prep).toContain('### Pull request #6 merge (recorded tip)');
    expect(prep).toContain(`| \`main\` tip recorded here | \`${PR6}\` |`);
    expect(prep).toContain(`| \`main\` commit | \`${PR5}\` |`);
    expect(prep).toContain(`- Pull request #6 merge \`${PR6}\`, sole parent the pull request #5 merge.`);
  });

  it('still stops a P0 listing on C2 or C3 and capture on C2, C3, or C5, and leaves both out of v1', () => {
    expect(prep).toMatch(/While C2 or C3 is unmet:/);
    expect(prep).toMatch(/- Do not run a P0 listing/);
    expect(prep).toMatch(/While C2, C3, or C5 is unmet:/);
    expect(prep).toMatch(/- Do not capture/);
    expect(prep).toMatch(/P0 does not wait for C5\. Capture waits for C5/);
    expect(prep).toContain('For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED).');
    expect(prep).toMatch(/Capture and P0 are not part of v1\./);
  });
});

describe('owner packet assertion fields stay blank', () => {
  const packet = read('docs/POST_MERGE_OWNER_PACKET.md');

  it('keeps C2, C3, and C5 blank', () => {
    const rows = packet.split('\n').filter((line) => /^\| C[235] \|/.test(line));
    expect(rows).toEqual(['| C2 | ________ |', '| C3 | ________ |', '| C5 | ________ |']);
  });

  it('records C2, C3, and C5 OUT OF SCOPE for v1 and reopened by a Kraken adapter, and claims none of them passed', () => {
    expect(packet).toContain('For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED); pursuing a Kraken adapter later reopens them.');
    expect(packet).not.toMatch(/\bC[235] (?:is |has |has been |was )?passed\b/i);
  });

  it('notes the pull request #6 merge on main as history, not a clearance', () => {
    expect(packet).toMatch(/pull request #6 \(documents and offline operations only\) are merged on `main`/);
    expect(packet).toContain('[RELEASE_PREP.md](RELEASE_PREP.md) records the pull request #6 merge as the tip.');
    expect(packet.match(/as the tip/g)).toEqual(['as the tip']);
    expect(packet).toMatch(/That is history, not a clearance, and it does not meet C2, C3, or C5\./);
  });
});

describe('README names the recorded tip', () => {
  const readme = read('README.md');

  it('says release prep records main through the pull request #6 merge', () => {
    expect(readme).toContain('recorded commits on `main` through the pull request #6 merge');
  });
});
