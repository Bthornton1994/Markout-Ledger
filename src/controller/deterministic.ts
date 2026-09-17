/**
 * Deterministic rule-based controller (Milestone 1).
 *
 * Rules, in priority order:
 *   1. kill switch active                -> quote nothing (sides 'none', size 0)
 *   2. fills this window with negative
 *      measured markout                  -> widen spread x1.5, shrink size x0.75, raise skew
 *   3. inventory utilisation > 60%       -> quote only the side that reduces inventory
 *   4. no fills this window              -> tighten spread x0.9 toward 1.0x, restore size toward 1.0x
 *   5. otherwise                         -> hold parameters
 * All arithmetic is integer and bounded by INSTRUCTION_BOUNDS.
 */
import { parseMoney } from '../core/money.js';
import {
  INSTRUCTION_SCHEMA_VERSION,
  DEFAULT_PARAMS,
  clampParams,
  type SteeringInstruction,
  type SteeringParams,
} from './instruction.js';
import type { ControllerContext, ControllerProposal, SteeringController, WindowReview } from './types.js';

export class DeterministicController implements SteeringController {
  readonly id: string;
  readonly kind = 'deterministic' as const;
  readonly modeledLatencyMs: number;

  constructor(opts: { id?: string; modeledLatencyMs?: number } = {}) {
    this.id = opts.id ?? 'deterministic-v1';
    this.modeledLatencyMs = opts.modeledLatencyMs ?? 0;
  }

  async decide(review: WindowReview, ctx: ControllerContext): Promise<ControllerProposal> {
    const prior = ctx.priorInstruction.params;
    const next: SteeringParams = { ...prior };
    const reasons: string[] = [];

    const markoutShortest = review.outcomes.measuredThisWindow[0];
    const measuredMarkout = markoutShortest ? parseMoney(markoutShortest.sumMarkout) : 0n;
    const measuredCount = markoutShortest?.count ?? 0;
    const util = review.risk.positionUtilizationMilli;
    const inventory = parseMoney(review.portfolio.inventory);

    if (review.risk.killSwitchActive) {
      next.quoteSides = 'none';
      next.sizeMultiplierMilli = 0;
      reasons.push('kill switch active: halt quoting');
    } else {
      if (measuredCount > 0 && measuredMarkout < 0n) {
        next.spreadMultiplierMilli = Math.floor((prior.spreadMultiplierMilli * 1500) / 1000);
        next.sizeMultiplierMilli = Math.floor((prior.sizeMultiplierMilli * 750) / 1000);
        next.inventorySkewBps = prior.inventorySkewBps + 15;
        reasons.push(`adverse markout ${markoutShortest!.sumMarkout} over ${measuredCount} outcomes: widen and shrink`);
      } else if (review.activity.fills === 0) {
        const towardBase = Math.max(DEFAULT_PARAMS.spreadMultiplierMilli, Math.floor((prior.spreadMultiplierMilli * 900) / 1000));
        next.spreadMultiplierMilli = prior.spreadMultiplierMilli > DEFAULT_PARAMS.spreadMultiplierMilli ? towardBase : prior.spreadMultiplierMilli;
        next.sizeMultiplierMilli = Math.min(DEFAULT_PARAMS.sizeMultiplierMilli, prior.sizeMultiplierMilli + 100);
        next.inventorySkewBps = Math.max(DEFAULT_PARAMS.inventorySkewBps, prior.inventorySkewBps - 5);
        reasons.push('no fills: relax toward base parameters');
      } else {
        reasons.push('fills with non-negative markout: hold parameters');
      }

      if (util > 600) {
        next.quoteSides = inventory > 0n ? 'ask_only' : 'bid_only';
        next.inventorySkewBps = Math.max(next.inventorySkewBps, 50);
        reasons.push(`inventory utilisation ${util}/1000: quote reducing side only`);
      } else {
        next.quoteSides = 'both';
      }
      if (next.sizeMultiplierMilli < 250) next.sizeMultiplierMilli = 250;
    }

    const instruction: SteeringInstruction = {
      schemaVersion: INSTRUCTION_SCHEMA_VERSION,
      version: ctx.nextVersion,
      controllerId: this.id,
      basedOnWindow: review.window.index,
      issuedAt: review.window.end,
      effectiveFrom: ctx.nextWindow.start,
      params: clampParams(next),
      reason: reasons.join('; ').slice(0, 240),
    };
    return { instruction, simulatedLatencyMs: this.modeledLatencyMs };
  }
}
