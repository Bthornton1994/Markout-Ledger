#!/usr/bin/env node
/**
 * markout-ledger CLI
 *
 *   replay            --scenario <name> [--fixture <path>] [--out <dir>] [--windows <n>]
 *   generate-fixtures [--out <dir>]
 */
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { SYNTHETIC_LABEL, fixtureContentHash } from '../market/events.js';
import { fmtMoney, fmtQty } from '../core/money.js';
import { loadFixture, saveFixture } from '../market/fixture-io.js';
import { FIXTURE_CATALOG, generateSyntheticFixture } from '../market/synthetic.js';
import { replay, type ReplayResult } from '../engine/replay.js';
import { SCENARIOS, buildRuns, type RunKind } from '../scenarios.js';
import { dec, milliX, relTime, table } from './format.js';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    }
  }
  return { command, flags };
}

function usage(): string {
  return [
    'markout-ledger',
    '  replay            --scenario baseline|riskgate [--fixture path] [--out dir] [--windows n]',
    '  generate-fixtures [--out dir]',
    '',
    'All fixtures shipped with this repository are SYNTHETIC. See docs/DATA_REQUIREMENTS.md.',
  ].join('\n');
}

async function cmdGenerateFixtures(outDir: string): Promise<void> {
  for (const [name, entry] of Object.entries(FIXTURE_CATALOG)) {
    const fixture = generateSyntheticFixture(entry.params());
    const path = join(outDir, entry.file.replace(/^fixtures\//, ''));
    saveFixture(path, fixture);
    console.log(`${name}: wrote ${path} (${fixture.events.length} events, seed ${entry.params().seed}, sha256 ${fixtureContentHash(fixture).slice(0, 12)})`);
  }
}

async function cmdReplay(flags: Record<string, string | boolean>): Promise<void> {
  const scenarioName = typeof flags['scenario'] === 'string' ? flags['scenario'] : 'baseline';
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const fixturePath = typeof flags['fixture'] === 'string' ? flags['fixture'] : scenario.fixtureFile;
  const outDir = join(typeof flags['out'] === 'string' ? flags['out'] : 'out', scenarioName);
  const numWindows = typeof flags['windows'] === 'string' ? Number(flags['windows']) : undefined;

  if (!existsSync(fixturePath)) {
    throw new Error(`fixture ${fixturePath} not found; run "npm run fixtures" first`);
  }
  const fixture = loadFixture(fixturePath);
  mkdirSync(outDir, { recursive: true });

  const banner = fixture.header.synthetic
    ? `!! ${SYNTHETIC_LABEL}`
    : '!! Recorded data fixture. Paper execution model only; results are research output, not evidence of profitability.';

  console.log('Markout Ledger replay');
  console.log('=====================');
  console.log(banner);
  console.log('');
  console.log(`Scenario: ${scenario.name} - ${scenario.description}`);
  const prov = fixture.header.provenance;
  console.log(
    `Fixture:  ${fixturePath} (${prov.source}${prov.seed !== undefined ? `, seed ${prov.seed}` : ''}${prov.generator ? `, ${prov.generator}@${prov.generatorVersion}` : ''}, ${fixture.header.eventCount} events, sha256 ${fixtureContentHash(fixture).slice(0, 12)})`,
  );
  const base = scenario.base;
  console.log(
    `Clocks:   policy tick ${base.policyTickMs} ms | window ${base.windowMs} ms | controller deadline ${base.controllerDeadlineMs} ms | outcome horizons ${base.outcomeHorizonsMs.join('/')} ms`,
  );
  console.log(
    `Costs:    maker fee ${base.execution.makerFeeBps} bps | placement ${dec(fmtMoney(base.execution.placementCost), 4)} | cancel ${dec(fmtMoney(base.execution.cancelCost), 4)} | order latency ${base.execution.orderLatencyMs} ms | cancel latency ${base.execution.cancelLatencyMs} ms`,
  );
  console.log(`Risk:     max position ${dec(fmtQty(base.risk.maxPosition), 3)} | max loss ${dec(fmtMoney(base.risk.maxLoss), 2)}`);
  console.log('');

  const results: Partial<Record<RunKind, ReplayResult>> = {};
  for (const run of buildRuns(scenario, numWindows)) {
    const ledgerPath = join(outDir, `${run.kind}.ledger.jsonl`);
    const stream = createWriteStream(ledgerPath, { encoding: 'utf8' });
    const result = await replay({
      fixture,
      policy: run.policy,
      controller: run.controller,
      config: run.config,
      ledgerSink: (line) => {
        stream.write(line + '\n');
      },
    });
    await new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
    results[run.kind] = result;
  }

  const runs = (['no_trade', 'unsteered', 'steered'] as const).map((k) => results[k]!);
  console.log('Run comparison (all runs replay the same fixture)');
  console.log(
    table(runs, [
      { header: 'run', get: (r) => r.summary.runId.split('/')[1] ?? r.summary.runId },
      { header: 'fills', get: (r) => String(r.summary.fills.count), align: 'right' },
      { header: 'buyQty', get: (r) => dec(r.summary.fills.buyQty, 3), align: 'right' },
      { header: 'sellQty', get: (r) => dec(r.summary.fills.sellQty, 3), align: 'right' },
      { header: 'fees', get: (r) => dec(r.summary.portfolio.feesPaid, 4), align: 'right' },
      { header: 'txCosts', get: (r) => dec(r.summary.portfolio.txCostsPaid, 4), align: 'right' },
      { header: 'realized', get: (r) => dec(r.summary.portfolio.grossRealized, 4), align: 'right' },
      { header: 'unrealized', get: (r) => dec(r.summary.portfolio.unrealized, 4), align: 'right' },
      { header: 'netPnl', get: (r) => dec(r.summary.portfolio.netPnl, 4), align: 'right' },
      { header: 'inv(end)', get: (r) => dec(r.summary.portfolio.inventory, 3), align: 'right' },
      { header: 'maxAbsInv', get: (r) => dec(r.summary.portfolio.maxAbsInventory, 3), align: 'right' },
      { header: 'lateFill', get: (r) => String(r.summary.fills.lateAfterCancel), align: 'right' },
      { header: 'preLive', get: (r) => String(r.summary.fills.ineligibleByReason.predatesActivation + r.summary.fills.ineligibleByReason.atActivationInstant), align: 'right' },
      { header: 'rejRisk', get: (r) => String(r.summary.orders.rejectedByRisk), align: 'right' },
      { header: 'kill', get: (r) => (r.summary.risk.killSwitchTripped ? 'yes' : 'no') },
      { header: 'instr', get: (r) => `v${r.summary.instructions.finalVersion}` },
      { header: 'markout1s', get: (r) => dec(r.summary.outcomes[0]?.sumMarkout ?? null, 4), align: 'right' },
      { header: 'ledger', get: (r) => String(r.summary.ledger.entries), align: 'right' },
    ]),
  );
  console.log('');

  const steered = results['steered']!;
  const origin = fixture.header.startTime;
  console.log('Steered run, per window (instruction version in effect at window end; markout = sum of shortest-horizon markouts measured in the window)');
  console.log(
    table(steered.summary.windowRows, [
      { header: 'win', get: (w) => String(w.window), align: 'right' },
      { header: 'start', get: (w) => relTime(w.start, origin) },
      { header: 'instr', get: (w) => w.instructionVersionsUsed.map((v) => `v${v}`).join('+') },
      { header: 'spread', get: (w) => milliX(w.params.spreadMultiplierMilli), align: 'right' },
      { header: 'size', get: (w) => milliX(w.params.sizeMultiplierMilli), align: 'right' },
      { header: 'skew', get: (w) => `${w.params.inventorySkewBps}bps`, align: 'right' },
      { header: 'sides', get: (w) => w.params.quoteSides },
      { header: 'subm', get: (w) => String(w.ordersSubmitted), align: 'right' },
      { header: 'rejRisk', get: (w) => String(w.ordersRejectedByRisk), align: 'right' },
      { header: 'canc', get: (w) => String(w.cancels), align: 'right' },
      { header: 'fills', get: (w) => String(w.fills), align: 'right' },
      { header: 'markout', get: (w) => dec(w.markoutShortest, 4), align: 'right' },
      { header: 'netPnl', get: (w) => dec(w.netPnl, 4), align: 'right' },
      { header: 'inv', get: (w) => dec(w.inventory, 3), align: 'right' },
      { header: 'midChg', get: (w) => (w.midChangeBps === null ? '-' : `${w.midChangeBps}bps`), align: 'right' },
    ]),
  );
  console.log('');
  console.log('Instruction history (steered run)');
  for (const h of steered.summary.instructions.history) {
    console.log(
      `  v${h.version} ${h.version === 0 ? 'initial' : `from window ${h.basedOnWindow}`}, effective ${relTime(h.effectiveFrom, origin)}: spread ${milliX(h.params.spreadMultiplierMilli)} size ${milliX(h.params.sizeMultiplierMilli)} skew ${h.params.inventorySkewBps}bps sides ${h.params.quoteSides} - ${h.reason}`,
    );
  }
  const rej = steered.summary.instructions;
  console.log(`  rejected: late=${rej.rejectedLate} failed=${rej.rejectedFailed} invalid=${rej.rejectedInvalid}`);
  console.log('');
  for (const r of runs) {
    if (r.summary.risk.killSwitchTripped) {
      console.log(`Risk: kill switch tripped in ${r.summary.runId} at ${relTime(r.summary.risk.killSwitchAt!, origin)}`);
    }
  }
  console.log(`Fill model: ${steered.summary.fillUncertainty.model}; trades at our price absorbed by queue ahead (no fill): steered=${steered.summary.fillUncertainty.queueConsumedWithoutFill}, unsteered=${results['unsteered']!.summary.fillUncertainty.queueConsumedWithoutFill}`);
  const vt = (r: ReplayResult) => {
    const f = r.summary.fills;
    return `${f.ineligibleByReason.predatesActivation + f.ineligibleByReason.atActivationInstant} pre-activation prints ignored, ${f.ineligibleByReason.afterCancellation} post-cancel near misses, ${f.lateAfterCancel} late fills after cancel, ${f.uncertain} unresolvable`;
  };
  console.log(`Venue-time eligibility: steered: ${vt(steered)}; unsteered: ${vt(results['unsteered']!)}`);
  console.log('');

  const resultsPath = join(outDir, 'results.json');
  const comparison = {
    disclaimer: 'SYNTHETIC RESEARCH OUTPUT. Paper execution on a generated fixture. These numbers are not evidence of profitability and must not be read as a strategy result.',
    syntheticLabel: fixture.header.synthetic ? SYNTHETIC_LABEL : null,
    scenario: { name: scenario.name, description: scenario.description },
    fixture: { path: fixturePath, contentHash: fixtureContentHash(fixture), header: fixture.header },
    runs: Object.fromEntries(runs.map((r) => [r.summary.runId.split('/')[1], r.summary])),
    comparison: {
      netPnl: Object.fromEntries(runs.map((r) => [r.summary.runId.split('/')[1], r.summary.portfolio.netPnl])),
      steeredMinusUnsteeredNetPnl: subtractDecimal(steered.summary.portfolio.netPnl, results['unsteered']!.summary.portfolio.netPnl),
      steeredMinusNoTradeNetPnl: subtractDecimal(steered.summary.portfolio.netPnl, results['no_trade']!.summary.portfolio.netPnl),
    },
    ledgers: Object.fromEntries(runs.map((r) => [r.summary.runId.split('/')[1], join(outDir, `${r.summary.runId.split('/')[1]}.ledger.jsonl`)])),
  };
  writeFileSync(resultsPath, JSON.stringify(comparison, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${resultsPath} and ${runs.length} ledgers (${runs.map((r) => `${r.summary.runId.split('/')[1]}: ${r.summary.ledger.entries} entries`).join(', ')}) to ${outDir}/`);
  console.log(`Wall time: ${runs.map((r) => `${r.summary.runId.split('/')[1]} ${r.diagnostics.wallMs.toFixed(0)}ms`).join(', ')}`);
}

function subtractDecimal(a: string, b: string): string {
  const scale = 1_000_000n;
  const toBig = (s: string): bigint => {
    const neg = s.startsWith('-');
    const [i = '0', f = ''] = s.replace('-', '').split('.');
    const v = BigInt(i) * scale + BigInt(f.padEnd(6, '0').slice(0, 6));
    return neg ? -v : v;
  };
  const d = toBig(a) - toBig(b);
  const neg = d < 0n;
  const abs = neg ? -d : d;
  return `${neg ? '-' : ''}${abs / scale}.${(abs % scale).toString().padStart(6, '0')}`;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'replay':
      await cmdReplay(flags);
      return;
    case 'generate-fixtures':
      await cmdGenerateFixtures(typeof flags['out'] === 'string' ? flags['out'] : 'fixtures');
      return;
    default:
      console.log(usage());
      if (command !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
