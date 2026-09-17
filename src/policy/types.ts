/**
 * Fast policy interface. Runs on every ~300 ms tick. Must be synchronous and pure:
 * it sees only the PolicyInput built from observations with obsTime <= now.
 */
import type { SteeringInstruction } from '../controller/instruction.js';

export interface BookView {
  eventId: string;
  obsTime: number;
  marketTime: number;
  bestBid: bigint;
  bestAsk: bigint;
  bidSize: bigint;
  askSize: bigint;
  mid: bigint;
}

export interface RestingView {
  orderId: string;
  price: bigint;
  qty: bigint;
  remainingQty: bigint;
  state: 'pending' | 'live';
}

export interface PolicyInput {
  now: number;
  tick: number;
  window: number;
  /** Latest valid book with obsTime <= now, or null. */
  book: BookView | null;
  bookAgeMs: number | null;
  inventory: bigint;
  maxPosition: bigint;
  instruction: SteeringInstruction;
  resting: { bid: RestingView | null; ask: RestingView | null };
}

export interface QuoteIntent {
  price: bigint;
  qty: bigint;
}

export interface PolicyDecision {
  /** quote: desired resting state is {bid, ask}; hold: leave orders as they are; pull: cancel everything. */
  intent: 'quote' | 'hold' | 'pull';
  bid: QuoteIntent | null;
  ask: QuoteIntent | null;
  reason: string;
}

export interface FastPolicy {
  readonly id: string;
  decide(input: PolicyInput): PolicyDecision;
}
