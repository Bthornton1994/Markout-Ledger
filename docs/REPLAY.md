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

Shared configuration (`src/scenarios.ts`): policy tick 300 ms, window 3000 ms, controller deadline 200 ms, staleness limit 500 ms, outcome horizons 1 s and 3 s (each horizon must be at least the staleness limit; configuration refuses shorter ones), initial cash 10 000, base half-spread 5 bps, base quote size 1.0, order/cancel latency 50 ms, maker fee 2 bps, placement cost 0.005, cancel cost 0.002, tick 0.01, lot 0.001.

Each scenario runs `no_trade`, `unsteered` (steering disabled) and `steered` (deterministic controller) on the same fixture.

## Configuration limits

`validateReplayConfig` (`src/engine/config.ts`) checks a run's configuration on its own; `validateReplayConfigAgainstFixture` adds the window count against the fixture's coverage and is what runs **before the replay starts**: the engine calls it first thing in its constructor, before the ledger exists, before `replay_started` is written and before the first fixture event is read; the CLI calls it for all three runs after reading the fixture and before it creates the output directory or any ledger file. A rejected configuration leaves nothing behind (both are tested: a 0 and an over-coverage `--windows` exit with the error on stderr, print nothing, and create no directory). Every rule throws a `RangeError` that names the field and the offending value.

| field | supported range | why |
|---|---|---|
| `policyTickMs` | integer `> 0` | fast-policy cadence |
| `windowMs` | integer `> 0`, a multiple of `policyTickMs` | every window ends on a tick |
| `controllerDeadlineMs` | integer, `0 <= d < windowMs` | an instruction must be ready inside the next window |
| `numWindows` | omitted (every whole window the fixture covers) or integer `>= 1`, at most that coverage (`windowsCovered(header, windowMs)`) | the replay ends on a window boundary the fixture contains |
| `execution.orderLatencyMs`, `execution.cancelLatencyMs` | integer `>= 0` (zero allowed) | modeled venue latencies |
| `maxStalenessMs` | integer `>= 0` | observations lagging more than this are rejected; it is also the exchange's reordering window, so it bounds how late a re-attribution can arrive |
| `outcomeHorizonsMs` | integers `> 0`, each `>= maxStalenessMs`, strictly increasing; may be empty; no upper bound | see below |

Outcome horizons: a re-attribution can move booked quantity to an earlier print up to `maxStalenessMs` after the print that established it, so a horizon shorter than `maxStalenessMs` could be measured before its provenance had settled. Such configurations are refused (a 100 ms horizon under the default 500 ms limit is the tested rejection; a 500 ms horizon under the same limit is the tested accepted boundary, also exercised in a full replay with a print at the maximum lag). Horizons must be strictly increasing because index 0 is the "shortest horizon" used by the deterministic controller and by the `markout` columns, and a repeated horizon would schedule the same measurement twice. There is no upper bound: a horizon that ends after the replay is never measured and is counted in `outcomesPendingAtEnd`.

## Outputs

```
out/<scenario>/results.json            disclaimer, synthetic label, fixture header + content hash,
                                       runs.{no_trade,unsteered,steered} summaries, comparison block
out/<scenario>/<run>.ledger.jsonl      the full hash-chained ledger of that run (see LEDGER_SCHEMA.md)
```

The console summary prints the synthetic label first, then a run comparison table, the steered run's per-window table (instruction version, spread/size/skew/sides in effect, submissions, risk rejections, cancels, fills, shortest-horizon markout, net P&L, inventory, mid change), the instruction history with each controller reason, kill-switch events, and the fill-uncertainty counters.

## Repeating a run

`tests/engine.test.ts` (`replay determinism`) replays both shipped scenarios as `no_trade`, `unsteered`, and `steered`, twice, and requires identical ledger JSONL and identical run summaries. To repeat from the CLI, check out one commit and run `npm run demo` twice. Compare `out/<scenario>/no_trade.ledger.jsonl`, `unsteered.ledger.jsonl`, and `steered.ledger.jsonl`. `results.json` stores each ledger path under `ledgers`, so compare that file only when both runs used the same output path. Console text includes wall time and is not a comparison artifact. A rejected configuration still leaves no output directory.

That repeat is the offline recovery. Production deployment and rollback requirements, with the target left blank, are in [DEPLOYMENT_ROLLBACK.md](DEPLOYMENT_ROLLBACK.md).

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
