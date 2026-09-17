# Replaying

## Commands

```bash
npm install
npm run typecheck                                  # tsc --noEmit (CI runs the same steps: .github/workflows/ci.yml)
npm test                                           # vitest run
npm run fixtures                                   # regenerate fixtures/*.jsonl from their seeds (byte-identical)
npm run replay -- --scenario baseline --out out    # one scenario, three runs
npm run replay -- --scenario riskgate --out out
npm run demo                                       # both scenarios
npm run check                                      # typecheck + tests + demo
```

`replay` flags:

| flag | meaning |
|---|---|
| `--scenario <name>` | `baseline` or `riskgate` (see `src/scenarios.ts`) |
| `--fixture <path>` | replay a different fixture file with the scenario's configuration |
| `--out <dir>` | output root (default `out/`); results land in `<dir>/<scenario>/` |
| `--windows <n>` | replay only the first `n` windows |

## Scenarios

| scenario | fixture | seed | windows | risk | what it shows |
|---|---|---|---|---|---|
| `baseline` | `fixtures/synthetic-baseline.jsonl` | 42 | 13 | max position 5, max loss 50 | mixed regimes; the controller widens after adverse markouts and relaxes when quiet |
| `riskgate` | `fixtures/synthetic-riskgate.jsonl` | 7 | 12 | max position 2, max loss 3 | persistent sell pressure; position-limit rejections, then the loss-limit kill switch |

Shared configuration (`src/scenarios.ts`): policy tick 300 ms, window 3000 ms, controller deadline 200 ms, staleness limit 500 ms, outcome horizons 1 s and 3 s, initial cash 10 000, base half-spread 5 bps, base quote size 1.0, order/cancel latency 50 ms, maker fee 2 bps, placement cost 0.005, cancel cost 0.002, tick 0.01, lot 0.001.

Each scenario runs `no_trade`, `unsteered` (steering disabled) and `steered` (deterministic controller) on the same fixture.

## Outputs

```
out/<scenario>/results.json            disclaimer, synthetic label, fixture header + content hash,
                                       runs.{no_trade,unsteered,steered} summaries, comparison block
out/<scenario>/<run>.ledger.jsonl      the full hash-chained ledger of that run (see LEDGER_SCHEMA.md)
```

The console summary prints the synthetic label first, then a run comparison table, the steered run's per-window table (instruction version, spread/size/skew/sides in effect, submissions, risk rejections, cancels, fills, shortest-horizon markout, net P&L, inventory, mid change), the instruction history with each controller reason, kill-switch events, and the fill-uncertainty counters.

Read the numbers as **mechanics**, not performance: with fixed placement and cancel costs a policy that requotes every tick pays for every message, and both trading runs in the shipped scenarios end with negative net P&L. That is the honest output of a conservative model on synthetic data.

## Adding a scenario or fixture

1. Add generator parameters in `src/market/synthetic.ts` (`FIXTURE_CATALOG`) or supply a recorded fixture that satisfies `docs/EVENT_SCHEMA.md` with `synthetic: false` and a `recorded` provenance.
2. Add an entry to `SCENARIOS` in `src/scenarios.ts` with its risk/policy configuration.
3. Run `npm run fixtures` (for synthetic ones) and commit the JSONL; the determinism test compares the committed bytes against the generator.

## Programmatic use

```ts
import { replay, loadFixture, MarketMakerPolicy, DeterministicController, DEFAULT_POLICY, DEFAULT_BASE } from './src/index.js';

const result = await replay({
  fixture: loadFixture('fixtures/synthetic-baseline.jsonl'),
  policy: new MarketMakerPolicy(DEFAULT_POLICY),
  controller: new DeterministicController(),
  config: { ...DEFAULT_BASE, runId: 'my-run', label: 'example', steering: 'enabled' },
  ledgerSink: (line) => process.stdout.write(line + '\n'),
});
result.summary.portfolio.netPnl; result.ledger.ofType('fill');
```
