// Locks the offline deployment/rollback requirements doc to blanks and to recorded git facts.
// A filled target, a filled C2/C3/C5 attestation, or a dropped recorded SHA fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PR3 = '890637815bb7370f75695dc20906eb12e9e289f6';
const PR4 = '9d89f9f2ba785856e0753c4ed2857a2c26b2394f';
const PR5 = '758defc624412666d4dea33bf76a705b6a0f7c52';

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

  it('leaves C2, C3, and C5 assertion fields blank', () => {
    expect(ops).toMatch(/C2, C3, and C5 remain unmet/);
    expect(ops).toMatch(/\| C2 \| ________ \|/);
    expect(ops).toMatch(/\| C3 \| ________ \|/);
    expect(ops).toMatch(/\| C5 \| ________ \|/);
    expect(ops).not.toMatch(/\bC[235] is met\b/);
  });

  it('keeps capture behind C2, C3, and C5 and describes only the offline synthetic replay repeat', () => {
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

  it('records pull requests #3, #4, and #5 and the verified Actions runs', () => {
    expect(prep).toContain(PR3);
    expect(prep).toContain(PR4);
    expect(prep).toContain(PR5);
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36214977668');
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36215785277');
    expect(prep).toContain('https://github.com/Bthornton1994/Markout-Ledger/actions/runs/36266694661');
    expect(prep).toMatch(/\[DEPLOYMENT_ROLLBACK\.md\]\(DEPLOYMENT_ROLLBACK\.md\)/);
    expect(prep).not.toMatch(/The sole git parent of the `main` tip is/);
  });

  it('still stops a P0 listing on C2 or C3 and capture on C2, C3, or C5', () => {
    expect(prep).toMatch(/While C2 or C3 is unmet:/);
    expect(prep).toMatch(/- Do not run a P0 listing/);
    expect(prep).toMatch(/While C2, C3, or C5 is unmet:/);
    expect(prep).toMatch(/- Do not capture/);
    expect(prep).toMatch(/P0 does not wait for C5\. Capture waits for C5/);
    expect(prep).toMatch(/C2, C3, and C5 remain unmet/);
  });
});

describe('owner packet assertion fields stay blank', () => {
  const packet = read('docs/POST_MERGE_OWNER_PACKET.md');

  it('keeps C2, C3, and C5 blank', () => {
    const rows = packet.split('\n').filter((line) => /^\| C[235] \|/.test(line));
    expect(rows).toEqual(['| C2 | ________ |', '| C3 | ________ |', '| C5 | ________ |']);
  });
});
