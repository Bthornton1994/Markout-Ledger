// Validates the JSON Schemas in schemas/ (draft 2020-12, Ajv strict mode, with the formats they use)
// against the documented examples in schemas/examples/ and against deliberate failure cases derived
// from those examples. Each failure case must fail for its stated reason and no other. Runs inside
// `npm test` and as its own CI step (`npm run test:schemas`). Development dependency only.
import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const addFormats = addFormatsModule.default;
const repoRoot = new URL('../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, repoRoot), 'utf8'));

type Json = Record<string, any>;
interface ExampleFile {
  description: string;
  examples: Record<string, Json>;
}
interface ExpectedError {
  instancePath: string;
  keyword: string;
  params?: Record<string, unknown>;
}
interface FailureCase {
  name: string;
  from: string;
  mutate: (doc: Json) => void;
  expected: ExpectedError[];
}

const CAPTURE_SCHEMA = 'schemas/capture-record.v1.schema.json';
const FIXTURE_SCHEMA = 'schemas/fixture.v2.schema.json';
const REPORT_SCHEMA = 'schemas/normalize-report.v1.schema.json';
const SCHEMAS = [CAPTURE_SCHEMA, FIXTURE_SCHEMA, REPORT_SCHEMA];
const FORMATS = ['date', 'date-time', 'uuid'] as const;

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv, [...FORMATS]);
  for (const schema of SCHEMAS) ajv.addSchema(readJson(schema) as object);
  return ajv;
}

const ajv = newAjv();
const captureId = (readJson(CAPTURE_SCHEMA) as Json).$id as string;
const fixtureId = (readJson(FIXTURE_SCHEMA) as Json).$id as string;
const reportId = (readJson(REPORT_SCHEMA) as Json).$id as string;

function validator(ref: string): ValidateFunction {
  const v = ajv.getSchema(ref);
  if (!v) throw new Error(`schema not found: ${ref}`);
  return v;
}

const capture = validator(captureId);
const fixture = validator(fixtureId);
const fixtureHeader = validator(`${fixtureId}#/$defs/header`);
const fixtureBook = validator(`${fixtureId}#/$defs/event/oneOf/0`);
const fixtureTrade = validator(`${fixtureId}#/$defs/event/oneOf/1`);
const normalizeReport = validator(reportId);

const captureExamples = (readJson('schemas/examples/capture-record.v1.examples.json') as ExampleFile).examples;
const fixtureExamples = (readJson('schemas/examples/fixture.v2.examples.json') as ExampleFile).examples;
const reportExamples = (readJson('schemas/examples/normalize-report.v1.examples.json') as ExampleFile).examples;

/** The errors that name a reason: Ajv also reports the enclosing if/then/else, which names none. */
function reasons(errors: ErrorObject[] | null | undefined): ExpectedError[] {
  return (errors ?? [])
    .filter((e) => e.keyword !== 'if')
    .map((e) => ({ instancePath: e.instancePath, keyword: e.keyword, params: e.params as Record<string, unknown> }));
}

/**
 * Values that contain no visible character under the schema's non-blank rule (fixture.v2 $defs/nonBlank). The first
 * two are required in every rights text field; the rest exercise the other classes the rule excludes.
 */
const INVISIBLE_IN_EVERY_FIELD: [string, string][] = [
  ['U+0085 (next line, Unicode whitespace outside ECMAScript \\s)', '\u0085'],
  ['U+200B (zero-width space, a format character)', '\u200b'],
];
const INVISIBLE_IN_NOTE: [string, string][] = [
  ['U+00A0 and U+3000 (other whitespace)', '\u00a0\u3000'],
  ['U+FEFF and U+2060 (format characters)', '\ufeff\u2060'],
  ['U+3164 (Hangul filler, default-ignorable)', '\u3164'],
  ['U+0301 (a combining mark alone)', '\u0301'],
  ['U+2800 (braille pattern blank)', '\u2800'],
  ['U+303F (ideographic half fill space)', '\u303f'],
  ['U+FFFC (object replacement character)', '\ufffc'],
  ['U+13441 and U+13442 (Egyptian hieroglyph full and half blank)', '\u{13441}\u{13442}'],
  ['U+1D159 (musical symbol null notehead)', '\u{1D159}'],
];

it('keeps the rights and A10 test sources pure ASCII, so every invisible test value is an escape that cannot be lost unseen', () => {
  expect(INVISIBLE_IN_EVERY_FIELD.map(([, v]) => v.codePointAt(0))).toEqual([0x85, 0x200b]);
  for (const [, value] of [...INVISIBLE_IN_EVERY_FIELD, ...INVISIBLE_IN_NOTE]) expect(value.length).toBeGreaterThan(0);
  for (const file of ['tests/schemas.test.ts', 'tests/repository-jsonl.test.ts']) {
    expect(readFileSync(new URL(file, repoRoot), 'utf8')).not.toMatch(/[^\t\n\r\x20-\x7e]/);
  }
});

function derive(examples: Record<string, Json>, c: FailureCase): Json {
  const base = examples[c.from];
  if (!base) throw new Error(`no example named ${c.from}`);
  const doc = structuredClone(base);
  c.mutate(doc);
  return doc;
}

function expectFailure(v: ValidateFunction, doc: Json, expected: ExpectedError[]): void {
  expect(v(doc)).toBe(false);
  const matchers = expected.map(({ params, ...rest }) =>
    expect.objectContaining(params ? { ...rest, params: expect.objectContaining(params) } : rest),
  );
  expect(reasons(v.errors)).toEqual(matchers);
}

describe('JSON Schemas (draft 2020-12, strict mode)', () => {
  it('every schema compiles in strict mode, and only once the formats it uses are loaded', () => {
    const fresh = new Ajv2020({ strict: true, allErrors: true });
    addFormats(fresh, [...FORMATS]);
    for (const schema of SCHEMAS) expect(() => fresh.compile(readJson(schema) as object)).not.toThrow();
    for (const schema of [CAPTURE_SCHEMA, FIXTURE_SCHEMA]) {
      const withoutFormats = new Ajv2020({ strict: true });
      expect(() => withoutFormats.compile(readJson(schema) as object)).toThrow(/unknown format/);
    }
  });
});

describe('capture-record.v1 schema', () => {
  it('has a documented example for every record type', () => {
    const schema = readJson(CAPTURE_SCHEMA) as Json;
    const types = new Set(Object.values(captureExamples).map((r) => r.type));
    expect([...types].sort()).toEqual([...(schema.properties.type.enum as string[])].sort());
  });

  it.each(Object.keys(captureExamples))('accepts the documented example %s', (name) => {
    const ok = capture(captureExamples[name]);
    expect(reasons(capture.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  const failures: FailureCase[] = [
    {
      name: 'manifest_end without processingMs',
      from: 'manifest_end',
      mutate: (d) => delete d.processingMs,
      expected: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'processingMs' } }],
    },
    {
      name: 'manifest_end with processingMs lacking p99',
      from: 'manifest_end',
      mutate: (d) => delete d.processingMs.p99,
      expected: [{ instancePath: '/processingMs', keyword: 'required', params: { missingProperty: 'p99' } }],
    },
    {
      name: 'manifest_end with a negative processingMs percentile',
      from: 'manifest_end',
      mutate: (d) => (d.processingMs.max = -1),
      expected: [{ instancePath: '/processingMs/max', keyword: 'minimum' }],
    },
    {
      name: 'a record without receive clocks',
      from: 'note',
      mutate: (d) => {
        delete d.recvWallMs;
        delete d.recvMonoNs;
      },
      expected: [
        { instancePath: '', keyword: 'required', params: { missingProperty: 'recvWallMs' } },
        { instancePath: '', keyword: 'required', params: { missingProperty: 'recvMonoNs' } },
      ],
    },
    {
      name: 'recvMonoNs written as a JSON number',
      from: 'message_book_update',
      mutate: (d) => (d.recvMonoNs = 5001123000000),
      expected: [{ instancePath: '/recvMonoNs', keyword: 'type', params: { type: 'string' } }],
    },
    {
      name: 'an unknown record type',
      from: 'probe',
      mutate: (d) => (d.type = 'snapshot_request'),
      expected: [{ instancePath: '/type', keyword: 'enum' }],
    },
    {
      name: 'ping without the verbatim request',
      from: 'ping',
      mutate: (d) => delete d.request,
      expected: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'request' } }],
    },
    {
      name: 'message without stream',
      from: 'message_trade',
      mutate: (d) => delete d.stream,
      expected: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'stream' } }],
    },
    {
      name: 'manifest_start without the instrument specification',
      from: 'manifest_start',
      mutate: (d) => delete d.instrumentSpec,
      expected: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'instrumentSpec' } }],
    },
    {
      name: 'manifest_start whose captureId is not a UUID (format)',
      from: 'manifest_start',
      mutate: (d) => (d.captureId = 'capture-1'),
      expected: [{ instancePath: '/captureId', keyword: 'format', params: { format: 'uuid' } }],
    },
    {
      name: 'manifest_start whose startedAtIso has no time zone (format)',
      from: 'manifest_start',
      mutate: (d) => (d.startedAtIso = '2026-09-22T12:00:00'),
      expected: [{ instancePath: '/startedAtIso', keyword: 'format', params: { format: 'date-time' } }],
    },
    {
      name: 'file_end whose sha256 is not lower-case hex',
      from: 'file_end',
      mutate: (d) => (d.sha256 = 'B'.repeat(64)),
      expected: [{ instancePath: '/sha256', keyword: 'pattern' }],
    },
    {
      name: 'manifest_start whose host block carries a hostname (closed object)',
      from: 'manifest_start',
      mutate: (d) => (d.host.hostname = 'capture-box-1'),
      expected: [{ instancePath: '/host', keyword: 'additionalProperties', params: { additionalProperty: 'hostname' } }],
    },
    {
      name: 'a ws_close whose detail is free text (the lifecycle table fixes every value)',
      from: 'ws_close',
      mutate: (d) => (d.detail = 'closed after a frame at 62710.4'),
      expected: [{ instancePath: '/detail', keyword: 'pattern' }],
    },
    {
      name: 'a ws_close whose close code is not a number',
      from: 'ws_close',
      mutate: (d) => (d.detail = 'remote_close:going_away'),
      expected: [{ instancePath: '/detail', keyword: 'pattern' }],
    },
    ...['liveness_timeout after a frame at 62710.4', 'x remote_close:1000', 'remote_close:1000 62710.4', 'connection_lost:going_away', 'connection_lost:10060', 'connection_lost:999'].map((detail) => ({
      name: `a ws_close detail that extends or bends a table value (${detail})`,
      from: 'ws_close',
      mutate: (d: Json) => (d.detail = detail),
      expected: [{ instancePath: '/detail', keyword: 'pattern' }],
    })),
    {
      name: 'a ws_error whose detail is outside the lifecycle table',
      from: 'ws_error',
      mutate: (d) => (d.detail = 'timeout'),
      expected: [{ instancePath: '/detail', keyword: 'enum' }],
    },
    {
      name: 'a ws_open whose detail names the endpoint',
      from: 'ws_open',
      mutate: (d) => (d.detail = 'connected wss://ws.kraken.com/v2'),
      expected: [{ instancePath: '/detail', keyword: 'const', params: { allowedValue: 'open' } }],
    },
  ];

  it.each(failures)('rejects $name, for that reason only', (c) => {
    expectFailure(capture, derive(captureExamples, c), c.expected);
  });

  it('accepts an additive undeclared field where the schema is deliberately open (forward compatibility)', () => {
    const doc = structuredClone(captureExamples.note!);
    doc.futureField = 'additive';
    expect(capture(doc)).toBe(true);
  });

  it('accepts every lifecycle detail of the contract table (section 8.1), close codes included', () => {
    const errors = ['connect_failed', 'connect_timeout', 'network_error', 'subscribe_rejected', 'resync_budget_exhausted', 'reconnect_budget_exhausted', 'capture_end', 'operator_stop'];
    const closes = ['resync_failed', 'snapshot_timeout', 'subscribe_ack_timeout', 'instrument_snapshot_timeout', 'liveness_timeout', 'network_error', 'subscribe_rejected', 'budget_exhausted', 'capture_end', 'operator_stop', 'remote_close:1000', 'remote_close:1001', 'connection_lost:1006', 'remote_close:4999'];
    for (const detail of errors) expect(capture({ ...captureExamples.ws_error!, detail })).toBe(true);
    for (const detail of closes) expect(capture({ ...captureExamples.ws_close!, detail })).toBe(true);
    expect(capture({ ...captureExamples.note!, detail: 'free text is allowed in a note' })).toBe(true);
  });

  it('accepts processingMs of zeros (no frame received)', () => {
    const doc = structuredClone(captureExamples.manifest_end!);
    doc.processingMs = { p50: 0, p99: 0, max: 0 };
    expect(capture(doc)).toBe(true);
  });
});

describe('fixture.v2 schema', () => {
  const definitionFor = (doc: Json): ValidateFunction =>
    doc.type === 'header' ? fixtureHeader : doc.type === 'book' ? fixtureBook : fixtureTrade;

  it.each(Object.keys(fixtureExamples))('accepts the documented example %s (root and its definition)', (name) => {
    const doc = fixtureExamples[name]!;
    expect(fixture(doc)).toBe(true);
    const own = definitionFor(doc);
    expect(own(doc)).toBe(true);
    expect(reasons(own.errors)).toEqual([]);
  });

  it('rejects a line that is neither a header nor an event', () => {
    expect(fixture({ type: 'quote', seq: 0 })).toBe(false);
  });

  // Constructed example: a schema pass checks the note's presence and shape only. It cannot show that the
  // attested record exists or clears anything; the owner verifies that substance by hand (contract section 6.3).
  it('accepts the shape of a permitted block with a non-blank placeholder note (constructed; establishes no permission)', () => {
    const doc = structuredClone(fixtureExamples.header_recorded_qty8!);
    doc.provenance.rights.redistribution = 'permitted';
    doc.provenance.rights.publication = 'sample_permitted';
    doc.provenance.rights.note = 'constructed placeholder: a real note identifies the owner attestation on pull request #3; this text establishes nothing';
    expect(fixtureHeader(doc)).toBe(true);
  });

  // The non-blank rule is about characters only: visible text in any script passes, including beside invisible
  // characters, and a pass says nothing about whether the value is true or sufficient.
  it('accepts non-blank rights text in any script, including a visible character beside invisible ones', () => {
    const doc = structuredClone(fixtureExamples.header_recorded_qty8!);
    doc.provenance.rights.checkedBy = 'Zo\u00eb \u00d8deg\u00e5rd';
    doc.provenance.rights.termsUrl = '\u200bhttps://example.org/terms';
    doc.provenance.rights.note = '\u78ba\u8a8d (constructed placeholder; establishes nothing)';
    expect(fixtureHeader(doc)).toBe(true);
    for (const value of ['x', '2026', '\u0085-', '\u0301a', '\u20ac', 'Zo\u00eb']) {
      doc.provenance.rights.checkedBy = value;
      expect(fixtureHeader(doc)).toBe(true);
    }
  });

  // Values made only of letters, digits or symbols outside the Latin script, in every rights field: the rule must keep
  // accepting visible text in any script, not only text that contains a Latin letter.
  const NON_LATIN_ONLY: [string, string][] = [
    ['Han', '\u78ba\u8a8d'],
    ['Arabic', '\u0645\u0627\u0644\u0643'],
    ['Devanagari, with combining marks', '\u0939\u093f\u0928\u094d\u0926\u0940'],
    ['Cyrillic', '\u0418\u0432\u0430\u043d'],
    ['Greek', '\u0391\u03b8\u03ae\u03bd\u03b1'],
    ['Hebrew', '\u05e9\u05dc\u05d5\u05dd'],
    ['Thai', '\u0e44\u0e17\u0e22'],
    ['Hangul', '\ud55c\uae00'],
    ['Arabic-Indic digits', '\u0661\u0662\u0663'],
    ['an emoji alone (a symbol)', '\u{1F600}'],
    ['CJK and Arabic punctuation', '\u3002\u061f'],
    ['a Devanagari danda', '\u0964'],
    ['Spanish and guillemet punctuation', '\u00bf\u00ab\u00bb'],
  ];
  it.each((['termsUrl', 'checkedBy', 'note'] as const).flatMap((field) => NON_LATIN_ONLY.map(([script, value]) => [field, script, value] as const)))(
    'accepts a %s made only of %s text',
    (field, _script, value) => {
      const doc = structuredClone(fixtureExamples.header_recorded_qty8!);
      doc.provenance.rights.redistribution = 'permitted';
      doc.provenance.rights.publication = 'sample_permitted';
      doc.provenance.rights.note = 'constructed placeholder; establishes nothing';
      doc.provenance.rights[field] = value;
      const ok = fixtureHeader(doc);
      expect(reasons(fixtureHeader.errors)).toEqual([]);
      expect(ok).toBe(true);
    },
  );

  it('accepts additive undeclared fields where the schema is deliberately open (forward compatibility)', () => {
    const doc = structuredClone(fixtureExamples.header_recorded_qty8!);
    doc.provenance.capture.futureCounter = 0;
    doc.provenance.rights.futureField = 'additive';
    expect(fixtureHeader(doc)).toBe(true);
    const event = structuredClone(fixtureExamples.event_trade!);
    event.futureField = 'additive';
    expect(fixtureTrade(event)).toBe(true);
  });

  const failures: (FailureCase & { target: ValidateFunction })[] = [
    {
      name: 'a recorded header without rights',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => delete d.provenance.rights,
      expected: [{ instancePath: '/provenance', keyword: 'required', params: { missingProperty: 'rights' } }],
    },
    {
      name: 'sample_permitted publication with redistribution unclear',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.publication = 'sample_permitted'),
      expected: [{ instancePath: '/provenance/rights/redistribution', keyword: 'const', params: { allowedValue: 'permitted' } }],
    },
    {
      name: 'redistribution permitted without a note',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => {
        d.provenance.rights.redistribution = 'permitted';
        delete d.provenance.rights.note;
      },
      expected: [{ instancePath: '/provenance/rights', keyword: 'required', params: { missingProperty: 'note' } }],
    },
    {
      name: 'redistribution permitted with an empty note',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => {
        d.provenance.rights.redistribution = 'permitted';
        d.provenance.rights.note = '';
      },
      expected: [{ instancePath: '/provenance/rights/note', keyword: 'pattern' }],
    },
    {
      name: 'redistribution permitted with a whitespace-only note',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => {
        d.provenance.rights.redistribution = 'permitted';
        d.provenance.rights.note = ' \t ';
      },
      expected: [{ instancePath: '/provenance/rights/note', keyword: 'pattern' }],
    },
    {
      name: 'a whitespace-only note on a hash-only block',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.note = '   '),
      expected: [{ instancePath: '/provenance/rights/note', keyword: 'pattern' }],
    },
    {
      name: 'an empty terms URL',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.termsUrl = ''),
      expected: [{ instancePath: '/provenance/rights/termsUrl', keyword: 'pattern' }],
    },
    {
      name: 'a whitespace-only terms URL',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.termsUrl = '   '),
      expected: [{ instancePath: '/provenance/rights/termsUrl', keyword: 'pattern' }],
    },
    {
      name: 'an empty checker',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.checkedBy = ''),
      expected: [{ instancePath: '/provenance/rights/checkedBy', keyword: 'pattern' }],
    },
    {
      name: 'a whitespace-only checker',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.checkedBy = '\n '),
      expected: [{ instancePath: '/provenance/rights/checkedBy', keyword: 'pattern' }],
    },
    ...(['termsUrl', 'checkedBy', 'note'] as const).flatMap((field) =>
      [...INVISIBLE_IN_EVERY_FIELD, ...(field === 'note' ? INVISIBLE_IN_NOTE : [])].map(([label, value]) => ({
        name: `a ${field} made only of ${label}${field === 'note' ? ' on a permitted block' : ''}`,
        from: 'header_recorded_qty8',
        target: fixtureHeader,
        mutate: (d: Json) => {
          if (field === 'note') {
            d.provenance.rights.redistribution = 'permitted';
            d.provenance.rights.publication = 'sample_permitted';
          }
          d.provenance.rights[field] = value;
        },
        expected: [{ instancePath: `/provenance/rights/${field}`, keyword: 'pattern' }],
      })),
    ),
    {
      name: 'a rights check date that is not a date (format)',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.rights.termsCheckedOn = '23/09/2026'),
      expected: [{ instancePath: '/provenance/rights/termsCheckedOn', keyword: 'format', params: { format: 'date' } }],
    },
    {
      name: 'a recorded header whose obsTime basis is venue time',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.timeBasis.obsTime = 'venue_time'),
      expected: [{ instancePath: '/provenance/timeBasis/obsTime', keyword: 'enum' }],
    },
    {
      name: 'third_party_receive without a vendor block',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.timeBasis.obsTime = 'third_party_receive'),
      expected: [{ instancePath: '/provenance/capture', keyword: 'required', params: { missingProperty: 'vendor' } }],
    },
    {
      name: 'a synthetic header whose label was altered',
      from: 'header_synthetic',
      target: fixtureHeader,
      mutate: (d) => (d.syntheticLabel = 'SYNTHETIC DATA'),
      expected: [{ instancePath: '/syntheticLabel', keyword: 'const' }],
    },
    {
      name: 'an unsupported quantity scale',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.qtyScale = 1000000000),
      expected: [{ instancePath: '/qtyScale', keyword: 'enum' }],
    },
    {
      name: 'an instrument with nine quantity decimals',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.instrumentSpec.qtyDecimals = 9),
      expected: [{ instancePath: '/provenance/instrumentSpec/qtyDecimals', keyword: 'maximum', params: { limit: 8 } }],
    },
    {
      name: 'an instrument specification without its integrity mechanism',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => delete d.provenance.instrumentSpec.integrity,
      expected: [{ instancePath: '/provenance/instrumentSpec', keyword: 'required', params: { missingProperty: 'integrity' } }],
    },
    {
      name: 'a fixture clock report carrying the verbatim report text',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.capture.clockReports.start.report = '<verbatim chronyc tracking output>'),
      expected: [{ instancePath: '/provenance/capture/clockReports/start/report', keyword: 'false schema' }],
    },
    {
      name: 'a fixture clock report carrying the report text under another key (closed object)',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.capture.clockReports.end.reportText = '<verbatim chronyc tracking output>'),
      expected: [{ instancePath: '/provenance/capture/clockReports/end', keyword: 'additionalProperties', params: { additionalProperty: 'reportText' } }],
    },
    {
      name: 'a clock-reports container carrying the report text beside start and end (closed object)',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.capture.clockReports.startReport = '<verbatim chronyc tracking output>'),
      expected: [{ instancePath: '/provenance/capture/clockReports', keyword: 'additionalProperties', params: { additionalProperty: 'startReport' } }],
    },
    {
      name: 'a venue clock offset without its resolution',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => delete d.provenance.capture.venueClockOffsetMs.resolutionMs,
      expected: [{ instancePath: '/provenance/capture/venueClockOffsetMs', keyword: 'required', params: { missingProperty: 'resolutionMs' } }],
    },
    {
      name: 'a capture block without integrity counts',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => delete d.provenance.capture.integrity,
      expected: [{ instancePath: '/provenance/capture', keyword: 'required', params: { missingProperty: 'integrity' } }],
    },
    {
      name: 'a segment with two checksum mismatches',
      from: 'header_recorded_qty6',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.capture.integrity.checksumMismatches = 2),
      expected: [{ instancePath: '/provenance/capture/integrity/checksumMismatches', keyword: 'maximum', params: { limit: 1 } }],
    },
    {
      name: 'a segment end reason outside the contract list',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.capture.endReason = 'gap_u'),
      expected: [{ instancePath: '/provenance/capture/endReason', keyword: 'enum' }],
    },
    {
      name: 'a capture block without the visible span',
      from: 'header_recorded_qty8',
      target: fixtureHeader,
      mutate: (d) => delete d.provenance.capture.visibleSpanBps,
      expected: [{ instancePath: '/provenance/capture', keyword: 'required', params: { missingProperty: 'visibleSpanBps' } }],
    },
    {
      name: 'a venue status entry without source and value',
      from: 'header_recorded_qty6',
      target: fixtureHeader,
      mutate: (d) => (d.provenance.capture.venueStatus[0] = { record: { fileIndex: 0, record: 40000, element: 0 }, system: 'post_only' }),
      expected: [
        { instancePath: '/provenance/capture/venueStatus/0', keyword: 'required', params: { missingProperty: 'source' } },
        { instancePath: '/provenance/capture/venueStatus/0', keyword: 'required', params: { missingProperty: 'value' } },
      ],
    },
    {
      name: 'a book level size with seven decimal places',
      from: 'event_book',
      target: fixtureBook,
      mutate: (d) => (d.bids[0].size = '0.0100000'),
      expected: [{ instancePath: '/bids/0/size', keyword: 'pattern' }],
    },
    {
      name: 'a trade price with eight decimal places',
      from: 'event_trade',
      target: fixtureTrade,
      mutate: (d) => (d.price = '62710.50000000'),
      expected: [{ instancePath: '/price', keyword: 'pattern' }],
    },
    {
      name: 'a trade aggressor outside buy, sell, unknown',
      from: 'event_trade',
      target: fixtureTrade,
      mutate: (d) => (d.aggressor = 'taker'),
      expected: [{ instancePath: '/aggressor', keyword: 'enum' }],
    },
    {
      name: 'an event whose obsTime is not an integer',
      from: 'event_trade',
      target: fixtureTrade,
      mutate: (d) => (d.obsTime = 1791288001130.5),
      expected: [{ instancePath: '/obsTime', keyword: 'type', params: { type: 'integer' } }],
    },
  ];

  it.each(failures)('rejects $name, for that reason only', (c) => {
    const doc = derive(fixtureExamples, c);
    expectFailure(c.target, doc, c.expected);
    expect(fixture(doc)).toBe(false);
  });
});

describe('normalize-report.v1 schema (closed: the data boundary of the report, contract section 5.10)', () => {
  it.each(Object.keys(reportExamples))('accepts the documented example %s', (name) => {
    const ok = normalizeReport(reportExamples[name]);
    expect(reasons(normalizeReport.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  // Every object node closed, every string node constrained: a structural check over the whole schema, so a node
  // added later without its constraint fails here even before it gets a derived failure case.
  it('closes every object and constrains every string of the schema', () => {
    const open: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
      if (typeof node !== 'object' || node === null) return;
      const n = node as Json;
      const types = ([] as unknown[]).concat(n.type ?? []);
      if (types.includes('object') && n.additionalProperties !== false) open.push(`${at}: object without additionalProperties false`);
      if (types.includes('string') && n.enum === undefined && n.const === undefined && n.pattern === undefined && n.format === undefined) open.push(`${at}: unconstrained string`);
      // if/then/else, not and contains only narrow what the declared properties already allow (they are applied on top of
      // them), so the shape definitions checked here are the declared ones.
      for (const [k, v] of Object.entries(n)) if (!['enum', 'const', 'if', 'then', 'else', 'not', 'contains'].includes(k)) walk(v, `${at}/${k}`);
    };
    walk(readJson(REPORT_SCHEMA), '');
    expect(open).toEqual([]);
  });

  const withSupersedes = (d: Json): void => {
    d.supersedes = [{ segmentIndex: 0, fixtureSha256: 'd'.repeat(64), normalizerVersion: '0.1.0', normalizerCommit: '89abcde', adapterVersion: '1' }];
  };
  const failures: FailureCase[] = [
    // Undeclared properties, at every closed object.
    { name: 'a report carrying a payload excerpt', from: 'report_segments', mutate: (d) => (d.payloadExcerpt = '{"channel":"book","type":"update"}'), expected: [{ instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: 'payloadExcerpt' } }] },
    { name: 'a normalizer block carrying a host name', from: 'report_segments', mutate: (d) => (d.normalizer.host = 'capture-box.local'), expected: [{ instancePath: '/normalizer', keyword: 'additionalProperties', params: { additionalProperty: 'host' } }] },
    { name: 'an adapter block carrying the endpoint', from: 'report_segments', mutate: (d) => (d.adapter.url = 'wss://ws.kraken.com/v2'), expected: [{ instancePath: '/adapter', keyword: 'additionalProperties', params: { additionalProperty: 'url' } }] },
    { name: 'an options block carrying the rights file', from: 'report_segments', mutate: (d) => (d.options.rights = 'rights.json'), expected: [{ instancePath: '/options', keyword: 'additionalProperties', params: { additionalProperty: 'rights' } }] },
    { name: 'a raw file entry carrying its path', from: 'report_segments', mutate: (d) => (d.rawFiles[0].path = 'captures/x-0.jsonl'), expected: [{ instancePath: '/rawFiles/0', keyword: 'additionalProperties', params: { additionalProperty: 'path' } }] },
    { name: 'a segment carrying free-text detail', from: 'report_segments', mutate: (d) => (d.segments[0].detail = 'checksum expected 1234567890, received 987654321'), expected: [{ instancePath: '/segments/0', keyword: 'additionalProperties', params: { additionalProperty: 'detail' } }] },
    { name: 'a rejection carrying free-text detail', from: 'report_segments', mutate: (d) => (d.rejections[0].detail = 'price_precision 1 vs pair_decimals 2'), expected: [{ instancePath: '/rejections/0', keyword: 'additionalProperties', params: { additionalProperty: 'detail' } }] },
    { name: 'a cut carrying free-text detail', from: 'report_segments', mutate: (d) => (d.cuts[0].detail = 'crossed at 62710.4 / 62710.3'), expected: [{ instancePath: '/cuts/0', keyword: 'additionalProperties', params: { additionalProperty: 'detail' } }] },
    { name: 'a record reference carrying a price', from: 'report_segments', mutate: (d) => (d.cuts[0].at.price = '62710.4'), expected: [{ instancePath: '/cuts/0/at', keyword: 'additionalProperties', params: { additionalProperty: 'price' } }] },
    { name: 'a dropped entry listing the dropped values', from: 'report_segments', mutate: (d) => (d.dropped.depthWhileUnsynced.values = ['62710.4', '0.25']), expected: [{ instancePath: '/dropped/depthWhileUnsynced', keyword: 'additionalProperties', params: { additionalProperty: 'values' } }] },
    { name: 'a supersedes entry carrying a note', from: 'report_segments', mutate: (d) => { withSupersedes(d); d.supersedes[0].note = 'rerun after the bid of 62710.4'; }, expected: [{ instancePath: '/supersedes/0', keyword: 'additionalProperties', params: { additionalProperty: 'note' } }] },
    // Closed names: only the contract's dropped keys, count keys and field names.
    { name: 'a dropped key the contract does not name (letters only)', from: 'report_segments', mutate: (d) => (d.dropped.pairStatusCancelOnly = { count: 1, records: [] }), expected: [{ instancePath: '/dropped', keyword: 'additionalProperties', params: { additionalProperty: 'pairStatusCancelOnly' } }] },
    { name: 'a dropped key that carries digits', from: 'report_segments', mutate: (d) => (d.dropped.price62710 = { count: 1, records: [] }), expected: [{ instancePath: '/dropped', keyword: 'additionalProperties', params: { additionalProperty: 'price62710' } }] },
    { name: 'a count key that spells a value in words', from: 'report_segments', mutate: (d) => (d.counts['bestBid.sixty_two_thousand'] = 1), expected: [{ instancePath: '/counts', keyword: 'additionalProperties', params: { additionalProperty: 'bestBid.sixty_two_thousand' } }] },
    { name: 'a count key naming a taker order type outside limit and market', from: 'report_segments', mutate: (d) => (d.counts['trades.ordType.reduce_only'] = 1), expected: [{ instancePath: '/counts', keyword: 'additionalProperties', params: { additionalProperty: 'trades.ordType.reduce_only' } }] },
    { name: 'a rejection whose field names a value', from: 'report_segments', mutate: (d) => (d.rejections[3].field = 'size 0.01'), expected: [{ instancePath: '/rejections/3/field', keyword: 'enum' }] },
    { name: 'a rejection whose field is a venue status word', from: 'report_segments', mutate: (d) => (d.rejections[3].field = 'reduce_only'), expected: [{ instancePath: '/rejections/3/field', keyword: 'enum' }] },
    // Values: integers only, and every string constrained.
    { name: 'a count that is not an integer (a price-like value)', from: 'report_segments', mutate: (d) => (d.counts['records.message'] = 62710.4), expected: [{ instancePath: '/counts/records.message', keyword: 'type', params: { type: 'integer' } }] },
    { name: 'a negative raw record index', from: 'report_segments', mutate: (d) => (d.cuts[0].at.record = -1), expected: [{ instancePath: '/cuts/0/at/record', keyword: 'minimum' }] },
    { name: 'a raw file hash that is not lower-case hex', from: 'report_segments', mutate: (d) => (d.rawFiles[0].sha256 = 'A'.repeat(64)), expected: [{ instancePath: '/rawFiles/0/sha256', keyword: 'pattern' }] },
    { name: 'a fixture hash written as text', from: 'report_segments', mutate: (d) => (d.segments[0].fixtureSha256 = 'bid 62710.4'), expected: [{ instancePath: '/segments/0/fixtureSha256', keyword: 'pattern' }, { instancePath: '/segments/0/fixtureSha256', keyword: 'pattern' }] },
    { name: 'a fixture file name that is not <captureId>-seg<n>.jsonl', from: 'report_segments', mutate: (d) => (d.segments[0].fixtureFile = '62710.4.jsonl'), expected: [{ instancePath: '/segments/0/fixtureFile', keyword: 'pattern' }, { instancePath: '/segments/0/fixtureFile', keyword: 'pattern' }] },
    { name: 'a capture identifier with a urn prefix and upper case', from: 'report_segments', mutate: (d) => (d.captureId = 'URN:UUID:123E4567-E89B-42D3-A456-426614174000'), expected: [{ instancePath: '/captureId', keyword: 'pattern' }] },
    { name: 'a normalizer name carrying JSON', from: 'report_segments', mutate: (d) => (d.normalizer.name = 'kraken {"a":1}'), expected: [{ instancePath: '/normalizer/name', keyword: 'const' }] },
    { name: 'an adapter name carrying a price in a name-shaped token', from: 'report_segments', mutate: (d) => (d.adapter.name = 'kraken-spot-ws2/bid-62710-4'), expected: [{ instancePath: '/adapter/name', keyword: 'const' }] },
    { name: 'a normalizer name carrying a trade id in a name-shaped token', from: 'report_segments', mutate: (d) => (d.normalizer.name = 'trade-id-81234567-market-buy'), expected: [{ instancePath: '/normalizer/name', keyword: 'const' }] },
    { name: 'a normalizer version written as free text', from: 'report_segments', mutate: (d) => (d.normalizer.version = '0.2.0 (dev build of 2026-10-06)'), expected: [{ instancePath: '/normalizer/version', keyword: 'pattern' }] },
    { name: 'a normalizer commit written as text', from: 'report_segments', mutate: (d) => (d.normalizer.commit = 'fix bid 62710.4'), expected: [{ instancePath: '/normalizer/commit', keyword: 'pattern' }] },
    { name: 'an adapter version written as text', from: 'report_segments', mutate: (d) => (d.adapter.version = '3 beta'), expected: [{ instancePath: '/adapter/version', keyword: 'pattern' }] },
    { name: 'a superseded normalizer version written as text', from: 'report_segments', mutate: (d) => { withSupersedes(d); d.supersedes[0].normalizerVersion = '0.1.0 dev'; }, expected: [{ instancePath: '/supersedes/0/normalizerVersion', keyword: 'pattern' }] },
    // Codes and structure.
    { name: 'a segment end reason outside the contract list', from: 'report_segments', mutate: (d) => (d.segments[0].endReason = 'venue_said_so'), expected: [{ instancePath: '/segments/0/endReason', keyword: 'enum' }] },
    { name: 'a planned end listed as a cut (it ends a segment without being one)', from: 'report_segments', mutate: (d) => d.cuts.push({ segmentIndex: 2, reason: 'capture_end', at: { fileIndex: 1, record: 59991 } }), expected: [{ instancePath: '/cuts/2/reason', keyword: 'enum' }] },
    { name: 'a rejection rule outside R1 to R10', from: 'report_segments', mutate: (d) => (d.rejections[0].rule = 'R11'), expected: [{ instancePath: '/rejections/0/rule', keyword: 'enum' }] },
    { name: 'an R9 socket reported as a refused segment', from: 'report_segments', mutate: (d) => (d.segments[2].rule = 'R9'), expected: [{ instancePath: '/segments/2/rule', keyword: 'enum' }, { instancePath: '/segments/2/rule', keyword: 'enum' }] },
    { name: 'a written segment without its fixture file', from: 'report_segments', mutate: (d) => (d.segments[0].fixtureFile = null), expected: [{ instancePath: '/segments/0/fixtureFile', keyword: 'type', params: { type: 'string' } }] },
    { name: 'a refused segment without the rule that refused it', from: 'report_segments', mutate: (d) => (d.segments[2].rule = null), expected: [{ instancePath: '/segments/2/rule', keyword: 'enum' }] },
    // Key presence: a segmented run lists every named key, so which keys are present carries nothing; a run refused at
    // capture level lists no segments, cuts, dropped items, counts or other rejections.
    { name: 'a rejection naming the manifest_start field (without a readable manifest_start there is no report)', from: 'report_r1_unsupported_version', mutate: (d) => (d.rejections[0].field = 'manifestStart'), expected: [{ instancePath: '/rejections/0/field', keyword: 'enum' }] },
    { name: 'a segmented report that leaves out a dropped key', from: 'report_segments', mutate: (d) => delete d.dropped.tradeDuplicate, expected: [{ instancePath: '/dropped', keyword: 'required', params: { missingProperty: 'tradeDuplicate' } }] },
    { name: 'a segmented report that leaves out a count key', from: 'report_segments', mutate: (d) => delete d.counts['records.probe'], expected: [{ instancePath: '/counts', keyword: 'required', params: { missingProperty: 'records.probe' } }] },
    { name: 'a capture-level refusal that lists a segment', from: 'report_no_fixture', mutate: (d) => d.segments.push({ segmentIndex: 0, status: 'too_short', startReason: 'capture_start', endReason: 'capture_end', start: { fileIndex: 0, record: 12 }, end: { fileIndex: 0, record: 40 }, events: 20, fixtureFile: null, fixtureSha256: null, rule: 'R7' }), expected: [{ instancePath: '/segments', keyword: 'maxItems' }] },
    { name: 'a capture-level refusal that lists a cut', from: 'report_no_fixture', mutate: (d) => d.cuts.push({ segmentIndex: 0, reason: 'clock_cut', at: { fileIndex: 0, record: 30 } }), expected: [{ instancePath: '/cuts', keyword: 'maxItems' }] },
    { name: 'a capture-level refusal that counts a dropped item', from: 'report_no_fixture', mutate: (d) => (d.dropped.undecodable = { count: 1, records: [{ fileIndex: 0, record: 30 }] }), expected: [{ instancePath: '/dropped', keyword: 'maxProperties' }] },
    { name: 'a capture-level refusal that counts records', from: 'report_no_fixture', mutate: (d) => (d.counts['records.message'] = 5), expected: [{ instancePath: '/counts', keyword: 'maxProperties' }] },
    { name: 'a capture-level refusal beside an item rejection', from: 'report_no_fixture', mutate: (d) => d.rejections.push({ rule: 'R4', scope: 'item', segmentIndex: 0, at: { fileIndex: 0, record: 30 }, field: 'size' }), expected: [{ instancePath: '/rejections/1/scope', keyword: 'const' }] },
    { name: 'a report without the raw file hashes', from: 'report_no_fixture', mutate: (d) => delete d.rawFiles, expected: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'rawFiles' } }] },
    { name: 'a report without the run options', from: 'report_no_fixture', mutate: (d) => delete d.options, expected: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'options' } }] },
  ];

  it.each(failures)('rejects $name, for that reason only', (c) => {
    expectFailure(normalizeReport, derive(reportExamples, c), c.expected);
  });
});

// The contract's text and the schemas must name the same codes, so neither can drift from the other unnoticed.
describe('the contract text and the schemas agree (docs/M2_DATA_CONTRACT.md)', () => {
  const contract = readFileSync(new URL('docs/M2_DATA_CONTRACT.md', repoRoot), 'utf8');
  const handoff = readFileSync(new URL('docs/M2_GROK_HANDOFF.md', repoRoot), 'utf8');
  const captureSchema = readJson(CAPTURE_SCHEMA) as Json;
  const reportSchema = readJson(REPORT_SCHEMA) as Json;
  const ticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
  const lineStarting = (prefix: string): string => {
    const lines = contract.split('\n').filter((l) => l.startsWith(prefix));
    expect(lines).toHaveLength(1);
    return lines[0]!;
  };
  const detailRule = (type: string): Json => {
    const branch = (captureSchema.allOf as Json[]).find((b) => b.if?.properties?.type?.const === type);
    if (!branch) throw new Error(`no branch for ${type}`);
    return branch.then.properties.detail as Json;
  };

  // Every (record type, detail) pair of the section 8.1 lifecycle table, read from its "records written" column.
  const lifecycleTable = (): Map<string, Set<string>> => {
    const start = contract.indexOf('| socket state | first condition to occur | records written | then |');
    expect(start).toBeGreaterThan(0);
    const rows = contract.slice(start).split('\n\n')[0]!.split('\n').slice(2);
    expect(rows.length).toBe(12);
    const details = new Map<string, Set<string>>([['ws_open', new Set()], ['ws_close', new Set()], ['ws_error', new Set()]]);
    for (const row of rows) {
      const cell = row.split('|')[3]!;
      let current: string[] = [];
      let lastWasType = false;
      for (const token of ticked(cell)) {
        if (details.has(token)) {
          current = lastWasType ? [...current, token] : [token];
          lastWasType = true;
        } else {
          for (const type of current) details.get(type)!.add(token);
          lastWasType = false;
        }
      }
    }
    return details;
  };

  it('the lifecycle table of section 8.1 and the raw-record schema name the same detail values', () => {
    const table = lifecycleTable();
    expect(sorted(table.get('ws_open')!)).toEqual([detailRule('ws_open').const]);
    expect(sorted(table.get('ws_error')!)).toEqual(sorted(detailRule('ws_error').enum as string[]));
    const pattern = detailRule('ws_close').pattern as string;
    const alternatives = pattern.replace(/^\^\(/, '').replace(/\)\$$/, '').split('|').map((a) => a.replace(':[1-4][0-9]{3}', ':<code>'));
    expect(sorted(table.get('ws_close')!)).toEqual(sorted(alternatives));
    for (const [type, values] of table) {
      for (const value of values) {
        for (const detail of value.includes('<code>') ? [value.replace('<code>', '1000'), value.replace('<code>', '1006')] : [value]) {
          expect(capture({ ...captureExamples[type]!, detail }), `${type} ${detail}`).toBe(true);
        }
      }
    }
  });

  it('section 5.10 lists exactly the dropped keys and field names of the report schema', () => {
    const counts = lineStarting('- Counts: ');
    const droppedList = counts.slice(counts.indexOf('named `dropped` keys ('), counts.indexOf('), each with'));
    expect(sorted(ticked(droppedList).filter((t) => t !== 'dropped'))).toEqual(sorted(Object.keys(reportSchema.properties.dropped.properties)));
    const codes = lineStarting('- Reason codes and rules: ');
    const fieldList = codes.slice(codes.indexOf('from a fixed list ('), codes.indexOf(').', codes.indexOf('from a fixed list (')));
    const fieldEnum = (reportSchema.$defs.rejection.properties.field.enum as (string | null)[]).filter((f): f is string => f !== null);
    expect(sorted(ticked(fieldList))).toEqual(sorted(fieldEnum));
  });

  it('every dropped key the contract or the handoff names is a key of the report schema, and every key is named', () => {
    const keys = Object.keys(reportSchema.properties.dropped.properties);
    const named = sorted([...`${contract}\n${handoff}`.matchAll(/dropped\.([A-Za-z]+)/g)].map((m) => m[1]!));
    expect(named.filter((k) => !keys.includes(k))).toEqual([]);
    expect(keys.filter((k) => !named.includes(k))).toEqual([]);
  });

  it('the rules of section 5.9 are exactly the report schema rules', () => {
    const rules = [...contract.matchAll(/^\| (R[0-9]+b?) \|/gm)].map((m) => m[1]!);
    expect(rules).toEqual(reportSchema.$defs.rule.enum);
  });

  it('the report counts records under exactly the record types of the raw-record schema', () => {
    const types = captureSchema.properties.type.enum as string[];
    const recordKeys = Object.keys(reportSchema.properties.counts.properties).filter((k) => k.startsWith('records.'));
    expect(sorted(recordKeys)).toEqual(sorted(types.map((t) => `records.${t}`)));
  });
});
