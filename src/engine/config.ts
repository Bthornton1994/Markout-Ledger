import { fmtMoney } from '../core/money.js';
import { type ExecutionConfig, executionConfigToWire } from '../execution/paper.js';
import type { RiskConfig } from '../risk/gate.js';
import { RiskGate } from '../risk/gate.js';

export interface ReplayConfig {
  runId: string;
  label: string;
  /** Fast policy cadence (ms). */
  policyTickMs: number;
  /** Controller window length (ms). */
  windowMs: number;
  /** Number of windows to replay; defaults to what the fixture covers. */
  numWindows?: number;
  /** An instruction must be ready by nextWindow.start + controllerDeadlineMs or it is discarded. */
  controllerDeadlineMs: number;
  steering: 'enabled' | 'disabled';
  /** Observations whose obsTime - marketTime exceeds this are rejected as stale. */
  maxStalenessMs: number;
  /** Horizons at which fill markouts are measured. */
  outcomeHorizonsMs: number[];
  initialCash: bigint;
  execution: ExecutionConfig;
  risk: RiskConfig;
}

export function configToWire(c: ReplayConfig): unknown {
  return {
    runId: c.runId,
    label: c.label,
    policyTickMs: c.policyTickMs,
    windowMs: c.windowMs,
    numWindows: c.numWindows ?? null,
    controllerDeadlineMs: c.controllerDeadlineMs,
    steering: c.steering,
    maxStalenessMs: c.maxStalenessMs,
    outcomeHorizonsMs: c.outcomeHorizonsMs,
    initialCash: fmtMoney(c.initialCash),
    execution: executionConfigToWire(c.execution),
    risk: new RiskGate(c.risk).toWire(),
  };
}

export function validateReplayConfig(c: ReplayConfig): void {
  if (!Number.isInteger(c.policyTickMs) || c.policyTickMs <= 0) throw new RangeError('policyTickMs must be a positive integer');
  if (!Number.isInteger(c.windowMs) || c.windowMs <= 0) throw new RangeError('windowMs must be a positive integer');
  if (c.windowMs % c.policyTickMs !== 0) throw new RangeError('windowMs must be a multiple of policyTickMs');
  if (!Number.isInteger(c.controllerDeadlineMs) || c.controllerDeadlineMs < 0) throw new RangeError('controllerDeadlineMs must be >= 0');
  if (c.controllerDeadlineMs >= c.windowMs) throw new RangeError('controllerDeadlineMs must be shorter than a window');
  if (c.numWindows !== undefined && (!Number.isInteger(c.numWindows) || c.numWindows < 1)) throw new RangeError('numWindows must be >= 1');
  for (const h of c.outcomeHorizonsMs) if (!Number.isInteger(h) || h <= 0) throw new RangeError('outcome horizons must be positive integers');
  if (c.execution.orderLatencyMs < 0 || c.execution.cancelLatencyMs < 0) throw new RangeError('latencies must be >= 0');
}
