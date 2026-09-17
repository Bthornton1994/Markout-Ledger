/**
 * Test/research helpers: scripted and null controllers.
 */
import { INSTRUCTION_SCHEMA_VERSION, type SteeringInstruction, type SteeringParams } from './instruction.js';
import type { ControllerContext, ControllerProposal, SteeringController, WindowReview } from './types.js';

export type ScriptStep =
  | { kind: 'params'; params: Partial<SteeringParams>; latencyMs?: number; reason?: string }
  | { kind: 'raw'; instruction: unknown; latencyMs?: number }
  | { kind: 'throw'; message: string }
  | { kind: 'hold' };

/** Emits a scripted sequence of proposals keyed by reviewed window index; records every input it sees. */
export class ScriptedController implements SteeringController {
  readonly id: string;
  readonly kind = 'scripted' as const;
  readonly modeledLatencyMs: number;
  readonly calls: Array<{ review: WindowReview; ctx: ControllerContext }> = [];

  constructor(
    private readonly script: Record<number, ScriptStep>,
    opts: { id?: string; modeledLatencyMs?: number } = {},
  ) {
    this.id = opts.id ?? 'scripted';
    this.modeledLatencyMs = opts.modeledLatencyMs ?? 0;
  }

  async decide(review: WindowReview, ctx: ControllerContext): Promise<ControllerProposal> {
    this.calls.push({ review, ctx });
    const step = this.script[review.window.index] ?? { kind: 'hold' };
    if (step.kind === 'throw') throw new Error(step.message);
    if (step.kind === 'raw') {
      const p: ControllerProposal = { instruction: step.instruction as SteeringInstruction };
      if (step.latencyMs !== undefined) p.simulatedLatencyMs = step.latencyMs;
      return p;
    }
    const params: SteeringParams = { ...ctx.priorInstruction.params, ...(step.kind === 'params' ? step.params : {}) };
    const instruction: SteeringInstruction = {
      schemaVersion: INSTRUCTION_SCHEMA_VERSION,
      version: ctx.nextVersion,
      controllerId: this.id,
      basedOnWindow: review.window.index,
      issuedAt: review.window.end,
      effectiveFrom: ctx.nextWindow.start,
      params,
      reason: step.kind === 'params' ? (step.reason ?? 'scripted') : 'scripted hold',
    };
    const p: ControllerProposal = { instruction };
    if (step.kind === 'params' && step.latencyMs !== undefined) p.simulatedLatencyMs = step.latencyMs;
    return p;
  }
}
