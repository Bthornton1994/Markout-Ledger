/**
 * Slow steering-controller interface.
 *
 * The engine invokes `decide` exactly once per completed window, at the window boundary,
 * and never on the fast (policy tick) path. The controller sees only the WindowReview,
 * which is built from observations and outcomes available at the boundary.
 */
import type { Decimal } from '../core/money.js';
import type { ValuationWire } from '../portfolio/accounting.js';
import type { InstructionBounds, SteeringInstruction, SteeringParams } from './instruction.js';

export interface WindowRef {
  index: number;
  start: number;
  end: number;
}

export interface OutcomeHorizonStats {
  horizonMs: number;
  count: number;
  sumMarkout: Decimal;
  avgMarkoutBps: Decimal;
  negativeCount: number;
}

export interface WindowReview {
  runId: string;
  window: WindowRef;
  /** Instruction versions the policy used during this window (usually one; two if a late-ready instruction applied mid-window). */
  instructionVersionsUsed: number[];
  paramsInEffectAtEnd: SteeringParams;
  market: {
    bookCount: number;
    tradeCount: number;
    tradeVolume: Decimal;
    sellAggressorVolume: Decimal;
    buyAggressorVolume: Decimal;
    firstMid: Decimal | null;
    lastMid: Decimal | null;
    minMid: Decimal | null;
    maxMid: Decimal | null;
    midChangeBps: Decimal | null;
    avgSpreadBps: Decimal | null;
    lastBookAgeMs: number | null;
    rejectedObservations: number;
  };
  activity: {
    ticks: number;
    quoteDecisions: number;
    holdDecisions: number;
    pullDecisions: number;
    ordersProposed: number;
    ordersSubmitted: number;
    ordersRejectedByRisk: number;
    ordersRejectedByVenue: number;
    cancelsRequested: number;
    cancelFillRaces: number;
    fills: number;
    fillQty: Decimal;
    buyFillQty: Decimal;
    sellFillQty: Decimal;
    partialFills: number;
    queueConsumedWithoutFill: number;
  };
  outcomes: {
    horizonsMs: number[];
    /** Outcomes whose measurement horizon elapsed within this window (may belong to earlier fills). */
    measuredThisWindow: OutcomeHorizonStats[];
    /** Fills whose outcomes are still pending at the window end. */
    pendingAtWindowEnd: number;
    cumulative: OutcomeHorizonStats[];
  };
  portfolio: ValuationWire & { maxAbsInventory: Decimal; fillCountCumulative: number };
  risk: {
    maxPosition: Decimal;
    maxLoss: Decimal;
    positionUtilizationMilli: number;
    killSwitchActive: boolean;
  };
}

export interface ControllerContext {
  priorInstruction: SteeringInstruction;
  nextWindow: WindowRef;
  nextVersion: number;
  bounds: InstructionBounds;
  /** The instruction must be ready by nextWindow.start + deadlineMs or it is discarded. */
  deadlineMs: number;
}

export interface ControllerProposal {
  /** Full candidate instruction. The engine validates it; nothing is clamped silently. */
  instruction: SteeringInstruction;
  /** Modeled think-time in simulated ms. Defaults to the controller's declared latency. */
  simulatedLatencyMs?: number;
  rationale?: string;
}

export interface SteeringController {
  readonly id: string;
  readonly kind: 'deterministic' | 'llm' | 'scripted' | 'null';
  /** Default modeled latency when a proposal does not specify one. */
  readonly modeledLatencyMs: number;
  decide(review: WindowReview, ctx: ControllerContext): Promise<ControllerProposal>;
}
