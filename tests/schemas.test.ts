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
  ];

  it.each(failures)('rejects $name, for that reason only', (c) => {
    expectFailure(capture, derive(captureExamples, c), c.expected);
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

  it('accepts sample_permitted publication when redistribution is permitted and the note names the C2 record', () => {
    const doc = structuredClone(fixtureExamples.header_recorded_qty8!);
    doc.provenance.rights.redistribution = 'permitted';
    doc.provenance.rights.publication = 'sample_permitted';
    doc.provenance.rights.note = 'constructed example: redistribution granted by <written record, date, pull request #3 comment>';
    expect(fixtureHeader(doc)).toBe(true);
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
      name: 'redistribution permitted without a note naming the C2 record',
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
      expected: [{ instancePath: '/provenance/rights/note', keyword: 'minLength' }],
    },
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
