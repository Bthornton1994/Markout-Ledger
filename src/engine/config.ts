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
  /**
   * Observations whose obsTime - marketTime exceeds this are rejected as stale. Non-negative integer ms. It is also
   * the bounded reordering window of the paper exchange, so it bounds how late a re-attribution can arrive.
   */
  maxStalenessMs: number;
  /**
   * Horizons at which fill markouts are measured, in ms. Positive integers, strictly increasing (index 0 is the
   * "shortest horizon" the controller and the CLI report), each at least `maxStalenessMs` (see validateReplayConfig).
   * May be empty. No upper bound: a horizon that ends after the replay is never measured and stays pending.
   */
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

/**
 * Checks a replay configuration on its own and throws a RangeError naming the field and the offending value.
 * Nothing here depends on the fixture; `validateReplayConfigAgainstFixture` adds the window-count check and is what
 * the engine and the CLI call before anything is constructed or written. The supported ranges are listed in
 * docs/REPLAY.md ("Configuration limits").
 */
export function validateReplayConfig(c: ReplayConfig): void {
  if (!Number.isInteger(c.policyTickMs) || c.policyTickMs <= 0) throw new RangeError(`policyTickMs must be a positive integer, got ${String(c.policyTickMs)}`);
  if (!Number.isInteger(c.windowMs) || c.windowMs <= 0) throw new RangeError(`windowMs must be a positive integer, got ${String(c.windowMs)}`);
  if (c.windowMs % c.policyTickMs !== 0) throw new RangeError(`windowMs must be a multiple of policyTickMs, got ${c.windowMs} ms and ${c.policyTickMs} ms`);
  if (!Number.isInteger(c.controllerDeadlineMs) || c.controllerDeadlineMs < 0) {
    throw new RangeError(`controllerDeadlineMs must be a non-negative integer, got ${String(c.controllerDeadlineMs)}`);
  }
  if (c.controllerDeadlineMs >= c.windowMs) throw new RangeError(`controllerDeadlineMs must be shorter than a window (${c.windowMs} ms), got ${c.controllerDeadlineMs} ms`);
  if (c.numWindows !== undefined && (!Number.isInteger(c.numWindows) || c.numWindows < 1)) {
    throw new RangeError(`numWindows must be an integer >= 1, got ${String(c.numWindows)}`);
  }
  for (const key of ['orderLatencyMs', 'cancelLatencyMs'] as const) {
    const v = c.execution[key];
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`execution.${key} must be a non-negative integer millisecond (zero is allowed), got ${String(v)}`);
  }
  // The staleness limit is validated before anything is compared against it.
  if (!Number.isInteger(c.maxStalenessMs) || c.maxStalenessMs < 0) throw new RangeError(`maxStalenessMs must be a non-negative integer, got ${String(c.maxStalenessMs)}`);

  if (!Array.isArray(c.outcomeHorizonsMs)) throw new RangeError(`outcomeHorizonsMs must be an array of horizons in ms, got ${String(c.outcomeHorizonsMs)}`);
  for (const h of c.outcomeHorizonsMs) if (!Number.isInteger(h) || h <= 0) throw new RangeError(`outcome horizons must be positive integers, got ${String(h)} ms`);
  // A re-attribution of a fill can arrive up to maxStalenessMs after the print that established it. If an outcome
  // horizon were shorter than that, an outcome could be measured before its quantity moves to its actual source
  // print and the recorded markout would not describe the final provenance. Refuse such configurations.
  for (const h of c.outcomeHorizonsMs) {
    if (h < c.maxStalenessMs) {
      throw new RangeError(
        `outcomeHorizonsMs must each be >= maxStalenessMs (${c.maxStalenessMs} ms) so no outcome can be measured before a re-attribution of its fill; got ${h} ms`,
      );
    }
  }
  // Index 0 is reported as the shortest horizon, and a repeated horizon would schedule the same measurement twice.
  for (let i = 1; i < c.outcomeHorizonsMs.length; i++) {
    const prev = c.outcomeHorizonsMs[i - 1]!;
    const cur = c.outcomeHorizonsMs[i]!;
    if (cur <= prev) throw new RangeError(`outcomeHorizonsMs must be strictly increasing, got ${prev} ms followed by ${cur} ms`);
  }
}

/** Whole windows of `windowMs` that a fixture spanning [startTime, endTime] covers. */
export function windowsCovered(header: { startTime: number; endTime: number }, windowMs: number): number {
  return Math.floor((header.endTime - header.startTime) / windowMs);
}

/**
 * Validates a configuration and resolves the number of windows the replay will cover against the fixture it will
 * replay. The engine calls this first thing in its constructor, before the ledger exists, before `replay_started`
 * is written and before the first fixture event is read; the CLI calls it for every run after reading the fixture
 * and before it creates the output directory or any ledger file. A rejected configuration leaves nothing behind.
 */
export function validateReplayConfigAgainstFixture(c: ReplayConfig, header: { startTime: number; endTime: number }): number {
  validateReplayConfig(c);
  const coverable = windowsCovered(header, c.windowMs);
  const numWindows = c.numWindows ?? coverable;
  if (numWindows < 1) throw new RangeError(`fixture covers ${coverable} full windows of ${c.windowMs} ms; at least one is required`);
  if (numWindows > coverable) throw new RangeError(`fixture covers only ${coverable} windows, ${numWindows} requested`);
  return numWindows;
}
