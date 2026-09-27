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
  /**
   * Ceiling on everything the model generates for this call. On a model that thinks, thinking tokens count toward
   * it even when their text is not returned, so a ceiling sized for the JSON answer alone cuts the reply off.
   */
  maxTokens: number;
  /**
   * JSON Schema the reply must satisfy. A client whose provider supports schema-constrained output passes it on;
   * a client that cannot may ignore it, and the controller still extracts the JSON object from free text.
   */
  outputSchema?: Readonly<Record<string, unknown>>;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

export interface LlmProposalJson {
  params: SteeringParams;
  reason: string;
}

/**
 * JSON Schema of the reply `decide` asks for (`LlmProposalJson`): types, required keys and the `quoteSides` values.
 * Numeric bounds and the reason length are left to the prompt and to the engine's validation, because
 * schema-constrained output commonly does not support `minimum`, `maximum` or `maxLength`.
 */
export const LLM_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {
        spreadMultiplierMilli: { type: 'integer' },
        sizeMultiplierMilli: { type: 'integer' },
        maxInventoryFractionMilli: { type: 'integer' },
        inventorySkewBps: { type: 'integer' },
        quoteSides: { type: 'string', enum: [...INSTRUCTION_BOUNDS.quoteSides] },
      },
      required: ['spreadMultiplierMilli', 'sizeMultiplierMilli', 'maxInventoryFractionMilli', 'inventorySkewBps', 'quoteSides'],
      additionalProperties: false,
    },
    reason: { type: 'string' },
  },
  required: ['params', 'reason'],
  additionalProperties: false,
} as const;

export const LLM_SYSTEM_PROMPT = [
  'You are the slow steering controller for a passive quoting policy in a paper-trading research replay.',
  'You receive a review of the window that just ended. Reply with one JSON object in this shape; the replay reads it as the instruction for the next window, and `reason` is where your explanation goes:',
  '{"params": {"spreadMultiplierMilli": int, "sizeMultiplierMilli": int, "maxInventoryFractionMilli": int, "inventorySkewBps": int, "quoteSides": "both"|"bid_only"|"ask_only"|"none"}, "reason": string}',
  `Bounds: ${JSON.stringify(INSTRUCTION_BOUNDS)}`,
  'Out-of-bounds values are rejected and the prior instruction stays in force.',
].join('\n');

export function renderReviewPrompt(review: WindowReview, ctx: ControllerContext): string {
  return [
    `Window ${review.window.index} ended at ${review.window.end}. Your instruction will apply to window ${ctx.nextWindow.index}.`,
    `Prior params: ${JSON.stringify(ctx.priorInstruction.params)}`,
    `Review: ${JSON.stringify(review)}`,
  ].join('\n');
}

/**
 * Extracts the outermost `{...}` from the reply. A client that passes `outputSchema` to its provider gets the bare
 * object back; the extraction stays for clients that do not (the fake client in the tests among them).
 */
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
    // Thinking counts toward the ceiling, so the default leaves room for it ahead of the short JSON answer.
    this.maxTokens = opts.maxTokens ?? 16000;
  }

  private readonly maxTokens: number;

  async decide(review: WindowReview, ctx: ControllerContext): Promise<ControllerProposal> {
    const text = await this.client.complete({
      system: LLM_SYSTEM_PROMPT,
      prompt: renderReviewPrompt(review, ctx),
      maxTokens: this.maxTokens,
      outputSchema: LLM_OUTPUT_SCHEMA,
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
