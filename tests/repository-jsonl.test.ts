// A10 (docs/M2_GROK_HANDOFF.md; docs/M2_DATA_CONTRACT.md section 6.3): every tracked .jsonl file must be an allowed
// fixture, and the rule fails closed on anything it cannot classify. The constructed cases below are illustrative:
// the venue frames use the public WebSocket API v2 field names with invented values, and a passing recorded-fixture
// case shows only that the rights block has the required shape. It establishes no permission; the owner verifies the
// attested clearance by hand before any recorded fixture is committed (decision condition C2).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyJsonl, readRepoFile, trackedJsonlFiles } from './jsonl-policy.js';

type Json = Record<string, any>;
const read = (path: string): string => readRepoFile(path);
const readJson = (path: string): Json => JSON.parse(read(path));
const jsonl = (values: unknown[]): string => values.map((v) => JSON.stringify(v)).join('\n') + '\n';

const synthetic = read('fixtures/synthetic-baseline.jsonl');
const syntheticLines = synthetic.split('\n').filter((l) => l.length > 0);
const syntheticHeader = (): Json => JSON.parse(syntheticLines[0]!);
const withLines = (lines: string[]): string => lines.join('\n') + '\n';
/** The synthetic fixture with its first trade event changed by `change`. */
function withTrade(change: (trade: Json) => void): string {
  const i = syntheticLines.findIndex((l) => JSON.parse(l).type === 'trade');
  const trade = JSON.parse(syntheticLines[i]!);
  change(trade);
  return withLines([...syntheticLines.slice(0, i), JSON.stringify(trade), ...syntheticLines.slice(i + 1)]);
}

const fixtureExamples = readJson('schemas/examples/fixture.v2.examples.json').examples as Record<string, Json>;
const captureExamples = readJson('schemas/examples/capture-record.v1.examples.json').examples as Record<string, Json>;
const v2Events = [fixtureExamples.event_book!, fixtureExamples.event_trade!];

/** A version-2 recorded fixture built from the constructed schema examples, with its rights block adjusted by `rights`. */
function recordedFixture(rights: (r: Json) => void, header: (h: Json) => void = () => {}): string {
  const h = structuredClone(fixtureExamples.header_recorded_qty8!);
  h.eventCount = v2Events.length;
  rights(h.provenance.rights);
  header(h);
  return jsonl([h, ...v2Events]);
}
const publishable = (r: Json): void => {
  r.redistribution = 'permitted';
  r.publication = 'sample_permitted';
  r.note = 'constructed placeholder: a real note identifies the owner attestation on pull request #3; this text establishes nothing';
};

// Unwrapped venue frames: what a capture stores, as text, in a `message` record's `payload` field, here without the
// capture record around it.
const venueFrames = {
  bookSnapshot: { channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 62710.5, qty: 0.25 }], asks: [{ price: 62710.6, qty: 0.1 }], checksum: 1234567890 }] },
  bookUpdate: { channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: [{ price: 62710.4, qty: 0 }], asks: [], checksum: 987654321, timestamp: '2026-10-06T12:00:00.123456Z' }] },
  trade: { channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: 'buy', price: 62710.6, qty: 0.01, ord_type: 'market', trade_id: 1, timestamp: '2026-10-06T12:00:00.130000Z' }] },
  heartbeat: { channel: 'heartbeat' },
  subscribeAck: { method: 'subscribe', result: { channel: 'book', symbol: 'BTC/USD', depth: 100, snapshot: true }, success: true, time_in: '2026-10-06T12:00:00.000000Z', time_out: '2026-10-06T12:00:00.000100Z', req_id: 1 },
};

describe('A10: every tracked .jsonl file is an allowed fixture (fail closed)', () => {
  const files = trackedJsonlFiles();

  it('finds the committed synthetic fixtures among the tracked .jsonl files', () => {
    expect(files).toEqual(expect.arrayContaining(['fixtures/synthetic-baseline.jsonl', 'fixtures/synthetic-riskgate.jsonl']));
  });

  it.each(files)('%s is an allowed fixture', (path) => {
    expect(classifyJsonl(read(path))).toEqual({ ok: true, kind: expect.any(String) });
  });
});

describe('A10 file listing', () => {
  const temps: string[] = [];
  const tempTree = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'a10-'));
    temps.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  afterEach(() => {
    for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const raw = jsonl([captureExamples.manifest_start, captureExamples.message_book_update]);

  it('lists tracked names literally and reads them as paths, so ?, #, % and backslashes cannot redirect it', () => {
    const odd = ['fixtures/synthetic-baseline.jsonl?raw.jsonl', 'fixtures/synthetic-baseline.jsonl#raw.jsonl', 'raw%41.jsonl', 'x\\y.jsonl', 'CAPS.JSONL'];
    const root = tempTree({ 'fixtures/synthetic-baseline.jsonl': synthetic, ...Object.fromEntries(odd.map((p) => [p, raw])) });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '-A', '-f'], { cwd: root, stdio: 'ignore' });
    const listed = trackedJsonlFiles(root);
    expect(listed).toEqual(expect.arrayContaining(odd));
    for (const path of odd) expect(classifyJsonl(readRepoFile(path, root))).toMatchObject({ ok: false, reason: expect.stringMatching(/raw capture record/) });
    expect(classifyJsonl(readRepoFile('fixtures/synthetic-baseline.jsonl', root))).toEqual({ ok: true, kind: 'synthetic_v1' });
  });

  it('fails on bytes that are not UTF-8 instead of decoding them to a replacement character', () => {
    const root = tempTree({});
    writeFileSync(join(root, 'bad.jsonl'), Buffer.concat([Buffer.from(synthetic.slice(0, 40)), Buffer.from([0x80, 0xbf, 0xff]), Buffer.from(synthetic.slice(40))]));
    expect(() => readRepoFile('bad.jsonl', root)).toThrow();
  });

  it('fails rather than guesses when git cannot list the files of a git checkout', () => {
    const root = tempTree({ '.git': 'not a git directory', 'a.jsonl': synthetic });
    expect(() => trackedJsonlFiles(root)).toThrow(/cannot list the tracked files/);
  });

  it('without .git, scans the whole tree except the root dependency and output directories, the capture directories included', () => {
    const root = tempTree({
      'fixtures/a.jsonl': synthetic,
      'captures/cap-0.jsonl': raw,
      'normalized/seg.jsonl': raw,
      'deep/out/raw.jsonl': raw,
      'node_modules/pkg/x.jsonl': raw,
      'out/baseline/steered.ledger.jsonl': raw,
      'dist/x.jsonl': raw,
    });
    expect(trackedJsonlFiles(root)).toEqual(['captures/cap-0.jsonl', 'deep/out/raw.jsonl', 'fixtures/a.jsonl', 'normalized/seg.jsonl']);
  });
});

describe('A10 classifier', () => {
  it('accepts the engine\'s version-1 synthetic fixture format', () => {
    expect(classifyJsonl(synthetic)).toEqual({ ok: true, kind: 'synthetic_v1' });
  });

  it('accepts the shape of a recorded fixture whose rights block is permitted + sample_permitted (constructed; establishes no permission)', () => {
    expect(classifyJsonl(recordedFixture(publishable))).toEqual({ ok: true, kind: 'recorded_v2_publishable' });
  });

  const rejects: [string, string, RegExp][] = [
    // Unwrapped venue frames and other unclassified JSONL.
    ['unwrapped book snapshot and update frames', jsonl([venueFrames.bookSnapshot, venueFrames.bookUpdate]), /not a fixture header/],
    ['unwrapped trade frames', jsonl([venueFrames.trade, venueFrames.trade]), /not a fixture header/],
    ['a heartbeat frame', jsonl([venueFrames.heartbeat]), /not a fixture header/],
    ['a subscription acknowledgement followed by a snapshot', jsonl([venueFrames.subscribeAck, venueFrames.bookSnapshot]), /not a fixture header/],
    ['an array-shaped frame', jsonl([[336, { a: [['62710.5', '0.25', '1791288001.130']] }, 'book-100', 'XBT/USD']]), /not a JSON object/],
    ['a synthetic fixture with an unwrapped venue frame appended', withLines([...syntheticLines, JSON.stringify(venueFrames.bookSnapshot)]), /parser rejects it: unknown market event type/],
    // Valid JSON objects or events without an allowed header.
    ['version-1 events without their header', withLines(syntheticLines.slice(1)), /not a fixture header/],
    ['version-2 events without a header', jsonl(v2Events), /not a fixture header/],
    ['an empty object followed by events', jsonl([{}, ...v2Events]), /not a fixture header/],
    ['a header that is not the first line', withLines([syntheticLines[1]!, syntheticLines[0]!, ...syntheticLines.slice(2)]), /not a fixture header/],
    ['a header with no schema version', jsonl([{ type: 'header' }, ...v2Events]), /schemaVersion undefined is not an allowed format/],
    ['a header with an unknown schema version', jsonl([{ ...syntheticHeader(), schemaVersion: 3 }]), /schemaVersion 3 is not an allowed format/],
    // Raw capture records, first or later.
    ['raw capture records', jsonl([captureExamples.manifest_start, captureExamples.message_book_update]), /line 1 is a raw capture record/],
    ['a raw capture record appended to a synthetic fixture', withLines([...syntheticLines, JSON.stringify(captureExamples.message_trade)]), /is a raw capture record/],
    ['a line carrying both receive clocks under an unknown type', withLines([...syntheticLines.slice(0, 2), JSON.stringify({ type: 'frame', recvWallMs: 1, recvMonoNs: '1' })]), /line 3 is a raw capture record/],
    // Recorded fixtures without the required rights shape.
    ['a recorded fixture whose rights are unclear and hash-only (the only admissible block today)', recordedFixture(() => {}), /only with redistribution "permitted" and publication "sample_permitted"/],
    ['a recorded fixture with redistribution permitted but publication hash-only', recordedFixture((r) => (r.redistribution = 'permitted')), /only with redistribution "permitted"/],
    ['a recorded fixture without a rights block', recordedFixture((r) => r, (h) => delete h.provenance.rights), /\$defs\/header: \/provenance must have required property 'rights'/],
    ['a recorded fixture whose permitted note is only a zero-width space', recordedFixture((r) => { publishable(r); r.note = '\u200b'; }), /\/provenance\/rights\/note must match pattern/],
    ['a recorded fixture whose event count does not match', recordedFixture(publishable, (h) => (h.eventCount = 3)), /eventCount 3 does not match the 2 events/],
    ['a recorded fixture with a line that is not a fixture event', withLines([...recordedFixture(publishable).trim().split('\n'), JSON.stringify({ type: 'book', seq: 9 })]), /event 3 does not match fixture.v2 \$defs\/event/],
    ['a version-1 header that is not synthetic', withLines([JSON.stringify({ ...syntheticHeader(), synthetic: false, provenance: { ...syntheticHeader().provenance, source: 'recorded' } }), ...syntheticLines.slice(1)]), /version-1 header must be synthetic/],
    // Synthetic-looking files outside the allowed format.
    ['a version-2 synthetic fixture', jsonl([{ ...fixtureExamples.header_synthetic, eventCount: 2 }, ...v2Events]), /version-2 synthetic fixture is not an allowed format/],
    ['a synthetic fixture whose label was altered', withLines([JSON.stringify({ ...syntheticHeader(), syntheticLabel: 'SYNTHETIC DATA' }), ...syntheticLines.slice(1)]), /parser rejects it: synthetic fixtures must carry the exact SYNTHETIC_LABEL/],
    ['a synthetic header carrying an undeclared key', withLines([JSON.stringify({ ...syntheticHeader(), venueFrames: [venueFrames.bookSnapshot] }), ...syntheticLines.slice(1)]), /outside the version-1 format: venueFrames is not a version-1 key/],
    ['a synthetic header carrying an undeclared provenance key', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, recordedFrom: 'wss://ws.kraken.com/v2' } }), ...syntheticLines.slice(1)]), /outside the version-1 format: provenance\.recordedFrom is not a version-1 key/],
    ['a synthetic header whose description holds raw capture records', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, description: { raw: [captureExamples.manifest_start, captureExamples.message_trade] } } }), ...syntheticLines.slice(1)]), /provenance\.description is missing or has a type outside the version-1 format/],
    ['a synthetic header whose seed holds venue frames', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, seed: [venueFrames.bookSnapshot, venueFrames.trade] } }), ...syntheticLines.slice(1)]), /provenance\.seed is missing or has a type/],
    ['a synthetic header whose time basis holds a venue frame', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, timeBasis: { ...syntheticHeader().provenance.timeBasis, obsTime: venueFrames.bookUpdate } } }), ...syntheticLines.slice(1)]), /provenance\.timeBasis\.obsTime is missing or has a type/],
    ['a synthetic header whose generator holds a raw capture record', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, generator: { raw: captureExamples.message_trade } } }), ...syntheticLines.slice(1)]), /provenance\.generator is missing or has a type/],
    ['a synthetic header whose generator version holds a raw capture record', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, generatorVersion: [captureExamples.manifest_start] } }), ...syntheticLines.slice(1)]), /provenance\.generatorVersion is missing or has a type/],
    ['a synthetic header whose quantity scale is an array', withLines([JSON.stringify({ ...syntheticHeader(), qtyScale: [1000000] }), ...syntheticLines.slice(1)]), /qtyScale is missing or has a type/],
    ['a synthetic header whose market time basis holds a venue frame', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, timeBasis: { ...syntheticHeader().provenance.timeBasis, marketTime: venueFrames.trade } } }), ...syntheticLines.slice(1)]), /provenance\.timeBasis\.marketTime is missing or has a type/],
    ['a synthetic header whose price scale is a string', withLines([JSON.stringify({ ...syntheticHeader(), priceScale: '1000000' }), ...syntheticLines.slice(1)]), /priceScale is missing or has a type/],
    ['a synthetic header without a time basis', withLines([JSON.stringify({ ...syntheticHeader(), provenance: { ...syntheticHeader().provenance, timeBasis: 'simulated' } }), ...syntheticLines.slice(1)]), /needs provenance\.timeBasis as an object/],
    ['a synthetic trade whose aggressor holds a raw capture record', withTrade((t) => (t.aggressor = { record: captureExamples.message_trade })), /aggressor is not buy, sell or unknown/],
    ['a synthetic trade without an aggressor', withTrade((t) => delete t.aggressor), /aggressor is not buy, sell or unknown/],
    ['a synthetic event carrying an undeclared key', withLines([syntheticLines[0]!, JSON.stringify({ ...JSON.parse(syntheticLines[1]!), frame: JSON.stringify(venueFrames.bookSnapshot) }), ...syntheticLines.slice(2)]), /does not reproduce it byte for byte/],
    ['a synthetic fixture with a blank line inside it', withLines([syntheticLines[0]!, '', ...syntheticLines.slice(1)]), /does not reproduce it byte for byte/],
    ['a synthetic fixture missing one event', withLines(syntheticLines.slice(0, -1)), /parser rejects it: fixture header eventCount/],
    // Files with nothing classifiable.
    ['invalid JSON after a valid header', withLines([syntheticLines[0]!, '{"eventId":']), /line 2 is not valid JSON/],
    ['an empty file', '', /no non-blank line/],
    ['a file of blank lines', '\n  \n\t\n', /no non-blank line/],
  ];

  it.each(rejects)('rejects %s', (_name, text, reason) => {
    const verdict = classifyJsonl(text);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(reason);
  });
});
