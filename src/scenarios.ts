/**
 * Scenario catalogue: fixture + engine/policy/risk configuration + the three comparison runs.
 */
import { MONEY_SCALE, QTY_SCALE, parseMoney, parseQty } from './core/money.js';
import { DeterministicController } from './controller/deterministic.js';
import type { SteeringController } from './controller/types.js';
import type { ReplayConfig } from './engine/config.js';
import type { ExecutionConfig } from './execution/paper.js';
import { FIXTURE_CATALOG, type SyntheticParams } from './market/synthetic.js';
import { MarketMakerPolicy, type MarketMakerConfig } from './policy/market-maker.js';
import { NoTradePolicy } from './policy/no-trade.js';
import type { FastPolicy } from './policy/types.js';
import type { RiskConfig } from './risk/gate.js';

export const TICK_SIZE = 10_000n; // 0.01
export const LOT_SIZE = 1_000n; // 0.001

export const DEFAULT_EXECUTION: ExecutionConfig = {
  orderLatencyMs: 50,
  cancelLatencyMs: 50,
  makerFeeBps: 2n,
  placementCost: parseMoney('0.005'),
  cancelCost: parseMoney('0.002'),
  tickSize: TICK_SIZE,
  lotSize: LOT_SIZE,
};

export const DEFAULT_POLICY: MarketMakerConfig = {
  baseHalfSpreadBps: 5n,
  baseQuoteQty: 1n * QTY_SCALE,
  maxBookAgeMs: 1000,
  requoteThresholdTicks: 2n,
  tickSize: TICK_SIZE,
  lotSize: LOT_SIZE,
};

export type BaseConfig = Omit<ReplayConfig, 'runId' | 'label' | 'steering'>;

export const DEFAULT_BASE: BaseConfig = {
  policyTickMs: 300,
  windowMs: 3000,
  controllerDeadlineMs: 200,
  maxStalenessMs: 500,
  outcomeHorizonsMs: [1000, 3000],
  initialCash: 10_000n * MONEY_SCALE,
  execution: DEFAULT_EXECUTION,
  risk: {
    maxPosition: parseQty('5'),
    maxOrderQty: parseQty('2'),
    maxLoss: parseMoney('50'),
    tickSize: TICK_SIZE,
    lotSize: LOT_SIZE,
  },
};

export interface Scenario {
  name: string;
  description: string;
  fixtureFile: string;
  fixtureParams: () => SyntheticParams;
  base: BaseConfig;
  policy: MarketMakerConfig;
}

export const SCENARIOS: Record<string, Scenario> = {
  baseline: {
    name: 'baseline',
    description: 'Mixed regimes; the deterministic controller reacts to adverse markouts and inventory.',
    fixtureFile: FIXTURE_CATALOG['baseline']!.file,
    fixtureParams: FIXTURE_CATALOG['baseline']!.params,
    base: DEFAULT_BASE,
    policy: DEFAULT_POLICY,
  },
  riskgate: {
    name: 'riskgate',
    description: 'Persistent sell pressure with tight limits; position limit and loss limit both engage.',
    fixtureFile: FIXTURE_CATALOG['riskgate']!.file,
    fixtureParams: FIXTURE_CATALOG['riskgate']!.params,
    base: {
      ...DEFAULT_BASE,
      risk: { ...DEFAULT_BASE.risk, maxPosition: parseQty('2'), maxLoss: parseMoney('3') } satisfies RiskConfig,
    },
    policy: DEFAULT_POLICY,
  },
};

export type RunKind = 'no_trade' | 'unsteered' | 'steered';

export interface RunSpec {
  kind: RunKind;
  policy: FastPolicy;
  controller: SteeringController | null;
  config: ReplayConfig;
}

export function buildRuns(scenario: Scenario, numWindows?: number): RunSpec[] {
  const base: BaseConfig = numWindows !== undefined ? { ...scenario.base, numWindows } : scenario.base;
  return [
    {
      kind: 'no_trade',
      policy: new NoTradePolicy(),
      controller: null,
      config: { ...base, runId: `${scenario.name}/no_trade`, label: 'no-trade baseline', steering: 'disabled' },
    },
    {
      kind: 'unsteered',
      policy: new MarketMakerPolicy(scenario.policy),
      controller: null,
      config: { ...base, runId: `${scenario.name}/unsteered`, label: 'market maker, steering disabled (v0 defaults throughout)', steering: 'disabled' },
    },
    {
      kind: 'steered',
      policy: new MarketMakerPolicy(scenario.policy),
      controller: new DeterministicController(),
      config: { ...base, runId: `${scenario.name}/steered`, label: 'market maker steered by deterministic controller', steering: 'enabled' },
    },
  ];
}
