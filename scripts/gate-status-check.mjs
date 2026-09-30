#!/usr/bin/env node
/**
 * Offline owner-gate status check. Reads four documents and exits 0 only while every C2, C3 and C5 fill field in them
 * is still blank (`________`) and each still says the gates are unmet; it then prints the owner-blocked list. Any filled
 * field, missing row or dropped unmet statement exits 1 with the reasons. It never reports a gate as cleared: a pass
 * means the blanks are intact, nothing more. It reads files only; no network, no git, no writes.
 *
 *   node scripts/gate-status-check.mjs              check this checkout
 *   node scripts/gate-status-check.mjs --root DIR   check the documents under DIR (used by tests/gate-status-blanks.test.ts)
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLANK = '________';

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = at >= 0 && args[at + 1] ? resolve(args[at + 1]) : resolve(fileURLToPath(new URL('..', import.meta.url)));

const problems = [];
const read = (path) => {
  try {
    // A Windows checkout with core.autocrlf has CRLF line ends; the rows are compared without them.
    return readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    problems.push(`${path}: missing`);
    return '';
  }
};

const rowsOf = (text, label) => text.split('\n').filter((line) => line.startsWith(`| ${label} |`));

/** Every table row of `text` whose first cell starts with one of `prefixes` must end in a blank owner cell. */
const requireBlankRows = (path, text, prefixes) => {
  const rows = text.split('\n').filter((line) => prefixes.some((p) => line.startsWith(`| ${p}`)));
  if (rows.length === 0) problems.push(`${path}: no ${prefixes.join('/')} owner rows found`);
  for (const row of rows) if (!row.endsWith(`| ${BLANK} |`)) problems.push(`${path}: owner field no longer blank: ${row}`);
  return rows.length;
};

const requireText = (path, text, needle) => {
  if (!text.includes(needle)) problems.push(`${path}: missing "${needle}"`);
};

/** Wording that would state a gate as cleared. The locked documents negate "C5 is met" ("No claim that C2, C3, or C5 is
 * met"), so only the table-cell form is refused there; the two owner documents this check was written with use none. */
const CLEARED_CELL = [/\|\s*MET\s*\|/];
const CLEARED = [...CLEARED_CELL, /\bC[235] is met\b/, /\bC[235] (?:has been|was) met\b/, /\bP0 (?:is )?authorized\b/i];
const refuseCleared = (path, text, patterns = CLEARED) => {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) problems.push(`${path}: states a gate as cleared: "${m[0]}"`);
  }
};

// Existing locked documents (tests/offline-ops.test.ts also locks these; this check repeats them for the owner run).
for (const path of ['docs/POST_MERGE_OWNER_PACKET.md', 'docs/DEPLOYMENT_ROLLBACK.md']) {
  const text = read(path);
  for (const gate of ['C2', 'C3', 'C5']) {
    const rows = rowsOf(text, gate);
    if (rows.length !== 1 || rows[0] !== `| ${gate} | ${BLANK} |`) problems.push(`${path}: ${gate} row is not exactly "| ${gate} | ${BLANK} |"`);
  }
  refuseCleared(path, text, CLEARED_CELL);
}
requireText('docs/DEPLOYMENT_ROLLBACK.md', read('docs/DEPLOYMENT_ROLLBACK.md'), 'C2, C3, and C5 remain unmet');

// The owner gate status document.
{
  const path = 'docs/OWNER_GATE_STATUS.md';
  const text = read(path);
  for (const gate of ['C2', 'C3', 'C5']) {
    const rows = rowsOf(text, gate).filter((row) => /^\| C\d \| [A-Z]+ \|/.test(row));
    if (rows.length !== 1 || rows[0] !== `| ${gate} | UNMET | ${BLANK} |`) problems.push(`${path}: ${gate} status row is not exactly "| ${gate} | UNMET | ${BLANK} |"`);
    requireText(path, text, `## ${gate}, `);
  }
  requireText(path, text, 'C2, C3, and C5 remain UNMET.');
  requireBlankRows(path, text, ['Use (', 'P0 payload', 'Currency', 'Pull request #3', 'Live quick-start', 'Host in', 'Operator resides', '`tradeIdOrdered`', '`per_fill`', '15 s liveness', 'Remaining section 4']);
  refuseCleared(path, text);
}

// The owner-only P0 checklist.
{
  const path = 'docs/OWNER_P0_READINESS.md';
  const text = read(path);
  requireText(path, text, '**NOT AUTHORIZED TO RUN.**');
  requireText(path, text, 'C2 and C3 are UNMET today');
  requireText(path, text, 'C5 is not required for P0. C5 is required before any capture');
  requireBlankRows(path, text, ['C2 ', 'C3 ', 'Listing date', 'Endpoint used', 'Pull request #3', 'Choice:']);
  refuseCleared(path, text);
}

if (problems.length > 0) {
  console.error('gate-status-check: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`gate-status-check: OK. C2, C3 and C5 are UNMET and every owner field is blank.
Owner-blocked (post each on pull request #3; see docs/OWNER_GATE_STATUS.md):
  C2  uses (i) to (iv), each: record date, source (Kraken or counsel acting for the owner), terms and uses addressed, outcome;
      use (iv) naming at least the P0 statement and the A12 outputs; the P0 payload retention answer;
      dated currency confirmation before the P0 listing and before each capture day.
  C3  live US quick-start page read date; host in a served US state (Y/N); operator resides in one (Y/N);
      read on the day of the P0 listing and before each capture day; no VPN or other workaround.
  C5  dated live-page outcome (confirms / contradicts / does not address) for tradeIdOrdered, per_fill and the
      15 s liveness timeout; dated readings of the remaining decision section 4 pages.
P0 listing: not authorized (waits for C2 and C3). Capture: not authorized (waits for C2, C3 and C5, and more).`);
