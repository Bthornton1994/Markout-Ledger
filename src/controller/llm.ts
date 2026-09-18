/**
 * Interface for a future LLM-backed steering controller.
 *
 * Nothing here performs a network call. `LlmClient` is injected; the milestone ships no
 * implementation that talks to a model provider. The engine only ever invokes a controller
 * at a window boundary, so an LLM call can never sit on the 300 ms policy path. The modeled
 * latency is what the engine uses for the deadline check, so a slow model shows up in the
 * ledger as `instruction_rejected(late)` rather than as a stalled policy.
 */
import { INSTRUCTION_BOUNDS, INSTRUCTION_SCHEMA_VERSION, type SteeringInstruction, type SteeringParams } from './instruction.js';
import type { ControllerContext, ControllerProposal, SteeringController, WindowReview } from './types.js';

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

export interface LlmProposalJson {
  params: SteeringParams;
  reason: string;
}

export const LLM_SYSTEM_PROMPT = [
  'You are the slow steering controller for a passive quoting policy in a paper-trading research replay.',
  'You receive a review of the window that just ended and must answer with ONE JSON object and nothing else:',
  '{"params": {"spreadMultiplierMilli": int, "sizeMultiplierMilli": int, "maxInventoryFractionMilli": int, "inventorySkewBps": int, "quoteSides": "both"|"bid_only"|"ask_only"|"none"}, "reason": string}',
  `Bounds: ${JSON.stringify(INSTRUCTION_BOUNDS)}`,
  'Out-of-bounds values are rejected and the prior instruction stays in force. Prefer small changes.',
].join('\n');

export function renderReviewPrompt(review: WindowReview, ctx: ControllerContext): string {
  return [
    `Window ${review.window.index} ended at ${review.window.end}. Your instruction will apply to window ${ctx.nextWindow.index}.`,
    `Prior params: ${JSON.stringify(ctx.priorInstruction.params)}`,
    `Review: ${JSON.stringify(review)}`,
  ].join('\n');
}

export function parseLlmProposal(text: string): LlmProposalJson {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in model output');
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<LlmProposalJson>;
  if (!parsed.params || typeof parsed.params !== 'object') throw new Error('model output lacks params');
  return { params: parsed.params, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
}

export class LlmSteeringController implements SteeringController {
  readonly id: string;
  readonly kind = 'llm' as const;
  readonly modeledLatencyMs: number;

  constructor(
    private readonly client: LlmClient,
    opts: { id?: string; modeledLatencyMs?: number; maxTokens?: number } = {},
  ) {
    this.id = opts.id ?? 'llm-controller';
    this.modeledLatencyMs = opts.modeledLatencyMs ?? 1500;
    this.maxTokens = opts.maxTokens ?? 400;
  }

  private readonly maxTokens: number;

  async decide(review: WindowReview, ctx: ControllerContext): Promise<ControllerProposal> {
    const text = await this.client.complete({
      system: LLM_SYSTEM_PROMPT,
      prompt: renderReviewPrompt(review, ctx),
      maxTokens: this.maxTokens,
    });
    const proposal = parseLlmProposal(text);
    // The model proposes params + reason only; the wrapper stamps the versioning fields.
    // The engine still validates the whole instruction and rejects anything out of contract.
    const instruction: SteeringInstruction = {
      schemaVersion: INSTRUCTION_SCHEMA_VERSION,
      version: ctx.nextVersion,
      controllerId: this.id,
      basedOnWindow: review.window.index,
      issuedAt: review.window.end,
      effectiveFrom: ctx.nextWindow.start,
      params: proposal.params,
      reason: proposal.reason.slice(0, INSTRUCTION_BOUNDS.reasonMaxLength),
    };
    return { instruction, simulatedLatencyMs: this.modeledLatencyMs, rationale: text.slice(0, 2000) };
  }
}
