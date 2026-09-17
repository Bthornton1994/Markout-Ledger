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
import type { ObservationRejectReason, RejectPhase } from '../market/validation.js';
import type { FillType, IneligibleReason, RaceOutcome } from '../execution/paper.js';
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
  /** structural: stream identity/ordering (duplicate, seq, out of order, range). content: the event itself. */
  phase: RejectPhase;
  /** Rejections are appended when the event is encountered in stream order, never earlier. */
  encounteredAt: number;
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
  /** Venue time of the book used for the queue estimate; it may precede liveAt by the feed lag. */
  bookMarketTime: number | null;
  bookLagMs: number | null;
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
  /** Sim time after which no late trade can be matched to this order; until then the cancel is provisional. */
  finalAt: number;
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
  tradeMarketTime: number;
  tradeObsTime: number;
  outcome: RaceOutcome;
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
  /** The print that filled us in venue order; its size bounds this fill. */
  sourceTradeEventId: string;
  sourceTradePrice: Decimal;
  sourceTradeSize: Decimal;
  /** Venue time of the source print: when the fill actually happened. */
  sourceMarketTime: number;
  /** The print whose observation established this fill; differs from the source when re-ordering released it. */
  establishedByTradeEventId: string;
  establishedByReordering: boolean;
  /** When the strategy learned and the portfolio was updated (== simTime). */
  observedAt: number;
  fillType: FillType;
  queueAheadBefore: Decimal;
  duringCancelPending: boolean;
  /** The trade was printed while the order was live but observed after the cancel took effect. */
  afterCancelEffective: boolean;
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

export interface FillReattributedEvent extends Base {
  type: 'fill_reattributed';
  orderId: string;
  /** The fill whose quantity is re-attributed and the portion it was split from. */
  fillId: string;
  fromPortionId: string;
  toPortionId: string;
  qty: Decimal;
  fromTradeEventId: string;
  fromMarketTime: number;
  toTradeEventId: string;
  toMarketTime: number;
  establishedByTradeEventId: string;
  observedAt: number;
  /** Horizons whose outcome had not been measured yet and now run from the new source's venue time. */
  outcomesRebased: number[];
  /** Horizons already measured on the old source; kept as measured, not re-run (no double counting). */
  outcomesKept: number[];
  note: string;
}

export interface FillIneligibleEvent extends Base {
  type: 'fill_ineligible';
  orderId: string;
  tradeEventId: string;
  tradeMarketTime: number;
  tradeObsTime: number;
  orderLiveAt: number;
  cancelEffectiveAt: number | null;
  reason: IneligibleReason;
  note: string;
}

export interface FillUncertainEvent extends Base {
  type: 'fill_uncertain';
  orderId: string;
  tradeEventId: string;
  tradeMarketTime: number;
  tradeObsTime: number;
  orderLiveAt: number;
  cancelEffectiveAt: number | null;
  /** The observation lag that caused the print to be discarded. */
  lagMs: number;
  reason: 'stale_print_discarded';
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
  /** The booked fill this portion belongs to, and the portion (a fill may be split by re-attribution). */
  fillId: string;
  portionId: string;
  orderId: string;
  side: Side;
  sourceTradeEventId: string;
  /** Venue time of the source print; the horizon is measured from here. */
  sourceMarketTime: number;
  /** When the portion was booked (or re-attributed). */
  observedAt: number;
  horizonMs: number;
  /** Sim time the outcome became available: max(sourceMarketTime + horizonMs, observedAt). */
  availableAt: number;
  fillPrice: Decimal;
  qty: Decimal;
  midAtHorizon: Decimal | null;
  midEventId: string | null;
  midMarketTime: number | null;
  midObsTime: number | null;
  /** venue_time: latest observed book whose marketTime <= fillMarketTime + horizon; fallback: latest observed book. */
  midSelection: 'venue_time' | 'latest_observed_fallback' | null;
  markout: Decimal | null;
  markoutBps: Decimal | null;
  status: 'measured' | 'unmeasurable_no_book' | 'superseded_by_reattribution';
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
  /** loss_limit trips the kill switch; position_overrun records a late fill pushing inventory past the limit. */
  kind: 'loss_limit' | 'position_overrun';
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
  | FillReattributedEvent
  | FillIneligibleEvent
  | FillUncertainEvent
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
