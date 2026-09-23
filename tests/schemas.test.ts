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
const FORMATS = ['date', 'date-time', 'uuid'] as const;

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv, [...FORMATS]);
  ajv.addSchema(readJson(CAPTURE_SCHEMA) as object);
  ajv.addSchema(readJson(FIXTURE_SCHEMA) as object);
  return ajv;
}

const ajv = newAjv();
const captureId = (readJson(CAPTURE_SCHEMA) as Json).$id as string;
const fixtureId = (readJson(FIXTURE_SCHEMA) as Json).$id as string;

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

const captureExamples = (readJson('schemas/examples/capture-record.v1.examples.json') as ExampleFile).examples;
const fixtureExamples = (readJson('schemas/examples/fixture.v2.examples.json') as ExampleFile).examples;

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
  it('both schemas compile in strict mode, and only once the formats they use are loaded', () => {
    const fresh = new Ajv2020({ strict: true, allErrors: true });
    addFormats(fresh, [...FORMATS]);
    expect(() => fresh.compile(readJson(CAPTURE_SCHEMA) as object)).not.toThrow();
    expect(() => fresh.compile(readJson(FIXTURE_SCHEMA) as object)).not.toThrow();
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
  ];

  it.each(failures)('rejects $name, for that reason only', (c) => {
    expectFailure(capture, derive(captureExamples, c), c.expected);
  });

  it('accepts an additive undeclared field where the schema is deliberately open (forward compatibility)', () => {
    const doc = structuredClone(captureExamples.note!);
    doc.futureField = 'additive';
    expect(capture(doc)).toBe(true);
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
