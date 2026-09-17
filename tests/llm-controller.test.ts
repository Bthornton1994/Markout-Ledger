import { describe, expect, it } from 'vitest';
import { LlmSteeringController, MarketMakerPolicy, DEFAULT_POLICY, replay, type LlmClient } from '../src/index.js';
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
});
