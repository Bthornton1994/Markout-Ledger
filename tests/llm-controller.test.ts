import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, LLM_OUTPUT_SCHEMA, LlmSteeringController, MarketMakerPolicy, DEFAULT_POLICY, replay, type LlmClient, type LlmRequest } from '../src/index.js';
import { T0, flatBooks, makeFixture, testConfig } from './helpers.js';

const books = flatBooks(0, 9000, '100.00', '100.02');

function client(responses: Array<string | Error>): LlmClient & { calls: number } {
  let i = 0;
  const c = {
    calls: 0,
    async complete() {
      c.calls++;
      const r = responses[i++] ?? responses[responses.length - 1]!;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return c;
}

describe('LLM controller interface (no network)', () => {
  it('accepts well-formed JSON within bounds and stamps the versioning fields itself', async () => {
    const c = client(['Here you go: {"params": {"spreadMultiplierMilli": 1200, "sizeMultiplierMilli": 900, "maxInventoryFractionMilli": 800, "inventorySkewBps": 30, "quoteSides": "both"}, "reason": "slightly wider"}']);
    const controller = new LlmSteeringController(c, { modeledLatencyMs: 150 });
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller, config: testConfig({ controllerDeadlineMs: 200 }) });
    expect(c.calls).toBe(2); // two completed windows with a next window; never on the 30 ticks
    const acc = r.ledger.ofType('instruction_accepted');
    expect(acc).toHaveLength(2);
    expect(acc[0]!.instruction.params.spreadMultiplierMilli).toBe(1200);
    expect(acc[0]!.instruction.version).toBe(1);
    expect(acc[0]!.readyAt).toBe(T0 + 3150);
  });

  it('out-of-bounds model output is rejected by the engine, garbage output is a controller failure, slow models are late', async () => {
    const c = client(['{"params": {"spreadMultiplierMilli": 99999, "sizeMultiplierMilli": 1000, "maxInventoryFractionMilli": 1000, "inventorySkewBps": 20, "quoteSides": "both"}, "reason": "yolo"}', 'I cannot help with that.']);
    const slow = client(['{"params": {"spreadMultiplierMilli": 1000, "sizeMultiplierMilli": 1000, "maxInventoryFractionMilli": 1000, "inventorySkewBps": 20, "quoteSides": "both"}, "reason": "ok"}']);
    const r = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller: new LlmSteeringController(c, { modeledLatencyMs: 0 }), config: testConfig() });
    expect(r.ledger.ofType('instruction_rejected').map((x) => x.reason)).toEqual(['invalid', 'controller_failed']);
    const s = await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller: new LlmSteeringController(slow, { modeledLatencyMs: 2500 }), config: testConfig() });
    expect(s.ledger.ofType('instruction_rejected').map((x) => x.reason)).toEqual(['late', 'late']);
    expect(s.summary.instructions.finalVersion).toBe(0);
  });

  it('sends the output schema and a token ceiling that leaves room for thinking', async () => {
    const requests: LlmRequest[] = [];
    const reply = JSON.stringify({ params: DEFAULT_PARAMS, reason: 'hold' });
    const capture: LlmClient = { async complete(req) { requests.push(req); return reply; } };
    await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller: new LlmSteeringController(capture, { modeledLatencyMs: 0 }), config: testConfig() });
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.maxTokens === 16000 && r.outputSchema === LLM_OUTPUT_SCHEMA)).toBe(true);
    const overridden: LlmRequest[] = [];
    await replay({ fixture: makeFixture(books, { durationMs: 9000 }), policy: new MarketMakerPolicy(DEFAULT_POLICY), controller: new LlmSteeringController({ async complete(req) { overridden.push(req); return reply; } }, { modeledLatencyMs: 0, maxTokens: 32000 }), config: testConfig() });
    expect(overridden.map((r) => r.maxTokens)).toEqual([32000, 32000]);
  });

  it('LLM_OUTPUT_SCHEMA accepts the reply shape and rejects missing, extra or mistyped fields', () => {
    const validate = new Ajv2020({ strict: true }).compile(LLM_OUTPUT_SCHEMA);
    const ok = { params: { ...DEFAULT_PARAMS }, reason: 'hold' };
    expect(validate(ok)).toBe(true);
    expect(validate({ params: ok.params })).toBe(false);
    expect(validate({ ...ok, extra: 1 })).toBe(false);
    expect(validate({ ...ok, params: { ...ok.params, spreadMultiplierMilli: 1000.5 } })).toBe(false);
    expect(validate({ ...ok, params: { ...ok.params, quoteSides: 'sell_only' } })).toBe(false);
    expect(validate({ ...ok, params: { ...ok.params, unknownParam: 1 } })).toBe(false);
  });
});
