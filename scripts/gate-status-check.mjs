#!/usr/bin/env node
/**
 * Offline v1 gate status check. Reads four documents and exits 0 only while the three status rows of
 * docs/OWNER_GATE_STATUS.md are exactly `| C2 | OUT_OF_SCOPE | ________ |` and the same for C3 and C5, every other C2,
 * C3 and C5 fill field in them is still blank (`________`), and each document still carries its v1 sentence; it then
 * prints the v1 status and what a reopened Kraken path would require. A row that says MET, PASS, PASSED or UNMET, a filled
 * field, a missing row, a dropped v1 sentence, or wording that states a gate as met, passed or cleared exits 1 with the
 * reasons. It never reports a gate as met or passed: a pass means the v1 status and the blanks are intact, nothing more.
 * It reads files only; no network, no git, no writes.
 *
 *   node scripts/gate-status-check.mjs              check this checkout
 *   node scripts/gate-status-check.mjs --root DIR   check the documents under DIR (used by tests/gate-status-blanks.test.ts)
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLANK = '________';
/** The v1 status of C2, C3 and C5: OUT OF SCOPE FOR V1, not passed and not met. */
const STATUS = 'OUT_OF_SCOPE';
/** A status no C2, C3 or C5 row of the v1 gate status may start with. */
const REFUSED_STATUS = /^(?:MET|PASS|PASSED|UNMET)\b/i;

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

/** The table rows whose first cell is `label`, whatever the spacing around it, so a reformatted row is still found. */
const rowsOf = (text, label) => text.split('\n').filter((line) => new RegExp(`^\\s*\\|\\s*${label}\\s*\\|`).test(line));
const cellsOf = (row) => row.trim().split('|').slice(1, -1).map((cell) => cell.trim());

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

/** Wording that would state a gate as met, passed or cleared. The locked documents negate "C5 is met" ("No claim that C2,
 * C3, or C5 is met"), so only the table-cell form is refused there; the two owner documents use none of these forms. */
const CLEARED_CELL = [/\|\s*(?:MET|PASS|PASSED)\s*\|/i];
const CLEARED = [
  ...CLEARED_CELL,
  /\bC[235] is met\b/i,
  /\bC[235] (?:has been|was) met\b/i,
  /\bC[235] (?:is |has |has been |was )?(?:passed|cleared)\b/i,
  /\bP0 (?:is )?authorized\b/i,
];
const refuseCleared = (path, text, patterns = CLEARED) => {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) problems.push(`${path}: states a gate as met, passed or cleared: "${m[0]}"`);
  }
};

// Existing locked documents and their v1 sentences (tests/offline-ops.test.ts also locks these; this check repeats them
// for the owner run).
const LOCKED = {
  'docs/POST_MERGE_OWNER_PACKET.md': 'For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED); pursuing a Kraken adapter later reopens them.',
  'docs/DEPLOYMENT_ROLLBACK.md': 'For v1, C2, C3, and C5 are OUT OF SCOPE (not PASSED).',
};
for (const [path, sentence] of Object.entries(LOCKED)) {
  const text = read(path);
  for (const gate of ['C2', 'C3', 'C5']) {
    const rows = rowsOf(text, gate);
    if (rows.length !== 1 || rows[0] !== `| ${gate} | ${BLANK} |`) problems.push(`${path}: ${gate} row is not exactly "| ${gate} | ${BLANK} |"`);
  }
  requireText(path, text, sentence);
  refuseCleared(path, text, CLEARED_CELL);
}

// The v1 gate status document.
{
  const path = 'docs/OWNER_GATE_STATUS.md';
  const text = read(path);
  for (const gate of ['C2', 'C3', 'C5']) {
    const rows = rowsOf(text, gate);
    // The status table is the only one whose C2, C3 and C5 rows have three cells; the non-claims rows have two.
    const status = rows.filter((row) => cellsOf(row).length === 3);
    if (status.length !== 1 || status[0] !== `| ${gate} | ${STATUS} | ${BLANK} |`) problems.push(`${path}: ${gate} status row is not exactly "| ${gate} | ${STATUS} | ${BLANK} |"`);
    for (const row of rows) if (REFUSED_STATUS.test(cellsOf(row)[1] ?? '')) problems.push(`${path}: ${gate} row says ${cellsOf(row)[1]}: ${row}`);
    requireText(path, text, `## ${gate}, `);
  }
  requireText(path, text, 'C2, C3, and C5 are OUT OF SCOPE FOR V1 (not PASSED).');
  requireText(path, text, 'Pursuing a Kraken adapter later reopens C2, C3, and C5.');
  requireBlankRows(path, text, ['Use (', 'P0 payload', 'Currency', 'Pull request #3', 'Live quick-start', 'Host in', 'Operator resides', '`tradeIdOrdered`', '`per_fill`', '15 s liveness', 'Remaining section 4']);
  refuseCleared(path, text);
}

// The owner-only P0 checklist: not authorized to run, and out of scope for v1.
{
  const path = 'docs/OWNER_P0_READINESS.md';
  const text = read(path);
  requireText(path, text, '**NOT AUTHORIZED TO RUN.**');
  requireText(path, text, 'The P0 listing is NOT AUTHORIZED and is out of scope for v1');
  requireText(path, text, 'For v1, C2 and C3 are OUT OF SCOPE (not PASSED)');
  requireText(path, text, 'C5 is not required for P0. C5 is required before any capture');
  requireBlankRows(path, text, ['C2 ', 'C3 ', 'Listing date', 'Endpoint used', 'Pull request #3', 'Choice:']);
  refuseCleared(path, text);
}

if (problems.length > 0) {
  console.error('gate-status-check: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`gate-status-check: OK. C2, C3 and C5 are OUT_OF_SCOPE for v1 and every owner field is blank.
v1 is offline evaluation: it runs no P0 listing and no capture, and no Kraken adapter is on its default path.
If a Kraken adapter is pursued later, C2, C3 and C5 reopen, and the owner then posts each item below on pull request #3
(reopened-gate requirements, not v1 work; see docs/OWNER_GATE_STATUS.md):
  C2  uses (i) to (iv), each: record date, source (Kraken or counsel acting for the owner), terms and uses addressed, outcome;
      use (iv) naming at least the P0 statement and the A12 outputs; the P0 payload retention answer;
      dated currency confirmation before the P0 listing and before each capture day.
  C3  live US quick-start page read date; host in a served US state (Y/N); operator resides in one (Y/N);
      read on the day of the P0 listing and before each capture day; no VPN or other workaround.
  C5  dated live-page outcome (confirms / contradicts / does not address) for tradeIdOrdered, per_fill and the
      15 s liveness timeout; dated readings of the remaining decision section 4 pages.
P0 listing: not authorized, and out of scope for v1. Capture: not authorized, and out of scope for v1.`);
