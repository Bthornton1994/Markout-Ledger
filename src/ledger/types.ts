/**
 * Append-only decision ledger event schema. See docs/LEDGER_SCHEMA.md.
 *
 * Every entry carries:
 *   ledgerSeq   position in the ledger (0-based, dense)
 *   simTime     simulated clock (ms epoch) at which the entry was appended
 *   type        discriminator
 *   prevHash / hash   SHA-256 chain over canonical JSON (tamper evidence)
 *
 * All money/price/qty fields are decimal strings (see core/money.ts scales).
 */
import type { Decimal } from '../core/money.js';
import type { Aggressor } from '../market/events.js';
import type { ObservationRejectReason } from '../market/validation.js';
import type { SteeringInstruction, SteeringParams } from '../controller/instruction.js';
import type { WindowReview } from '../controller/types.js';

export const LEDGER_SCHEMA_VERSION = 1 as const;

import type { Side } from '../core/side.js';

interface Base {
  simTime: number;
}

export interface ReplayStartedEvent extends Base {
  type: 'replay_started';
  runId: string;
  label: string;
  synthetic: boolean;
  syntheticLabel: string | null;
  fixture: {
    symbol: string;
    venue: string;
    contentHash: string;
    eventCount: number;
    startTime: number;
    endTime: number;
    provenance: unknown;
  };
  config: unknown;
  assumptions: string[];
}

export interface ObservationEvent extends Base {
  type: 'observation';
  eventId: string;
  seq: number;
  kind: 'book' | 'trade';
  obsTime: number;
  marketTime: number;
  feedLagMs: number;
  /** Compact content: top of book (book) or the print (trade). Fields not applicable are null. */
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  bidSize: Decimal | null;
  askSize: Decimal | null;
  price: Decimal | null;
  size: Decimal | null;
  aggressor: Aggressor | null;
}

export interface ObservationRejectedEvent extends Base {
  type: 'observation_rejected';
  eventId: string;
  seq: number;
  obsTime: number;
  marketTime: number;
  reason: ObservationRejectReason;
  detail: string;
  phase: 'structural' | 'content';
}

export interface PolicyDecisionEvent extends Base {
  type: 'policy_decision';
  tick: number;
  window: number;
  policyId: string;
  instructionVersion: number;
  instructionEffectiveFrom: number;
  input: {
    bookEventId: string | null;
    bookObsTime: number | null;
    bookAgeMs: number | null;
    bestBid: Decimal | null;
    bestAsk: Decimal | null;
    inventory: Decimal;
    restingBid: { orderId: string; price: Decimal; qty: Decimal } | null;
    restingAsk: { orderId: string; price: Decimal; qty: Decimal } | null;
  };
  decision: {
    intent: 'quote' | 'hold' | 'pull';
    bid: { price: Decimal; qty: Decimal } | null;
    ask: { price: Decimal; qty: Decimal } | null;
    reason: string;
  };
  /** Set when the policy threw; the decision is then forced to 'pull'. */
  policyError?: string;
}

export interface OrderProposedEvent extends Base {
  type: 'order_proposed';
  clientId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  tick: number;
}

export interface OrderRejectedEvent extends Base {
  type: 'order_rejected';
  clientId: string;
  orderId: string | null;
  side: Side;
  price: Decimal;
  qty: Decimal;
  rejectedBy: 'risk_gate' | 'venue';
  reason: string;
  detail: string;
}

export interface OrderSubmittedEvent extends Base {
  type: 'order_submitted';
  orderId: string;
  clientId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  submittedAt: number;
  expectedLiveAt: number;
  placementCost: Decimal;
}

export interface OrderLiveEvent extends Base {
  type: 'order_live';
  orderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  liveAt: number;
  queueAhead: Decimal;
  queueSource: string;
  bookEventId: string | null;
  fillUncertainty: string;
}

export interface CancelRequestedEvent extends Base {
  type: 'cancel_requested';
  orderId: string;
  requestedAt: number;
  expectedEffectiveAt: number;
  cancelCost: Decimal;
  reason: string;
}

export interface CancelEffectiveEvent extends Base {
  type: 'cancel_effective';
  orderId: string;
  remainingQty: Decimal;
  filledQty: Decimal;
}

export interface CancelTooLateEvent extends Base {
  type: 'cancel_too_late';
  orderId: string;
  reason: 'already_filled' | 'already_cancelled' | 'already_rejected';
}

export interface CancelFillRaceEvent extends Base {
  type: 'cancel_fill_race';
  orderId: string;
  tradeEventId: string;
  cancelRequestedAt: number;
  cancelEffectiveAt: number;
  tradeObsTime: number;
  outcome: 'fill_wins';
  rule: string;
}

export interface FillEvent extends Base {
  type: 'fill';
  fillId: string;
  orderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  notional: Decimal;
  fee: Decimal;
  isPartial: boolean;
  remainingQty: Decimal;
  tradeEventId: string;
  tradePrice: Decimal;
  tradeSize: Decimal;
  fillType: 'trade_through' | 'queue_exhausted';
  queueAheadBefore: Decimal;
  duringCancelPending: boolean;
  /** Accounting effect of this fill. */
  realizedDelta: Decimal;
  inventoryAfter: Decimal;
  cashAfter: Decimal;
}

export interface QueueConsumedEvent extends Base {
  type: 'queue_consumed';
  orderId: string;
  tradeEventId: string;
  tradeSize: Decimal;
  queueAheadBefore: Decimal;
  queueAheadAfter: Decimal;
  note: string;
}

export interface TxCostEvent extends Base {
  type: 'tx_cost';
  orderId: string;
  kind: 'placement' | 'cancel';
  amount: Decimal;
  cashAfter: Decimal;
}

export interface OutcomeEvent extends Base {
  type: 'outcome';
  fillId: string;
  orderId: string;
  side: Side;
  fillTime: number;
  horizonMs: number;
  availableAt: number;
  fillPrice: Decimal;
  qty: Decimal;
  midAtHorizon: Decimal | null;
  midEventId: string | null;
  markout: Decimal | null;
  markoutBps: Decimal | null;
  status: 'measured' | 'unmeasurable_no_book';
}

export interface ControllerInputEvent extends Base {
  type: 'controller_input';
  window: number;
  review: WindowReview;
}

export interface ControllerOutputEvent extends Base {
  type: 'controller_output';
  window: number;
  controllerId: string;
  proposal: unknown;
  /** Modeled think-time. Wall-clock timings are deliberately kept out of the ledger so it stays deterministic. */
  simulatedLatencyMs: number;
  readyAt: number;
}

export interface InstructionAcceptedEvent extends Base {
  type: 'instruction_accepted';
  instruction: SteeringInstruction;
  readyAt: number;
  deadlineAt: number;
  appliesFrom: number;
}

export interface InstructionRejectedEvent extends Base {
  type: 'instruction_rejected';
  window: number;
  reason: 'late' | 'controller_failed' | 'invalid';
  detail: string;
  readyAt: number | null;
  deadlineAt: number;
  keptInstructionVersion: number;
}

export interface ControllerSkippedEvent extends Base {
  type: 'controller_skipped';
  window: number;
  reason: 'steering_disabled' | 'no_next_window';
  instructionVersion: number;
}

export interface RiskBreachEvent extends Base {
  type: 'risk_breach';
  kind: 'loss_limit';
  detail: string;
  netPnl: Decimal;
  limit: Decimal;
  action: string;
}

export interface WindowSummaryEvent extends Base {
  type: 'window_summary';
  window: number;
  start: number;
  end: number;
  instructionVersionsUsed: number[];
  paramsInEffectAtEnd: SteeringParams;
  fills: number;
  fillQty: Decimal;
  ordersSubmitted: number;
  ordersRejected: number;
  cancels: number;
  netPnl: Decimal;
  inventory: Decimal;
}

export interface ReplayFinishedEvent extends Base {
  type: 'replay_finished';
  runId: string;
  summary: unknown;
}

export type LedgerEvent =
  | ReplayStartedEvent
  | ObservationEvent
  | ObservationRejectedEvent
  | PolicyDecisionEvent
  | OrderProposedEvent
  | OrderRejectedEvent
  | OrderSubmittedEvent
  | OrderLiveEvent
  | CancelRequestedEvent
  | CancelEffectiveEvent
  | CancelTooLateEvent
  | CancelFillRaceEvent
  | FillEvent
  | QueueConsumedEvent
  | TxCostEvent
  | OutcomeEvent
  | ControllerInputEvent
  | ControllerOutputEvent
  | InstructionAcceptedEvent
  | InstructionRejectedEvent
  | ControllerSkippedEvent
  | RiskBreachEvent
  | WindowSummaryEvent
  | ReplayFinishedEvent;

export type LedgerEventType = LedgerEvent['type'];

export type LedgerEntry = LedgerEvent & {
  ledgerSeq: number;
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  prevHash: string;
  hash: string;
};
