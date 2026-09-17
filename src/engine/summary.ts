import type { Decimal } from '../core/money.js';
import type { SteeringParams } from '../controller/instruction.js';
import type { OutcomeHorizonStats } from '../controller/types.js';
import type { ValuationWire } from '../portfolio/accounting.js';

export interface WindowRow {
  window: number;
  start: number;
  end: number;
  instructionVersionsUsed: number[];
  params: SteeringParams;
  ticks: number;
  ordersSubmitted: number;
  ordersRejectedByRisk: number;
  cancels: number;
  fills: number;
  fillQty: Decimal;
  markoutShortest: Decimal | null;
  netPnl: Decimal;
  inventory: Decimal;
  midChangeBps: string | null;
}

export interface RunSummary {
  runId: string;
  label: string;
  synthetic: boolean;
  syntheticLabel: string | null;
  disclaimer: string;
  fixture: { symbol: string; venue: string; contentHash: string; eventCount: number; seed: number | null; generator: string | null };
  policyId: string;
  steering: 'enabled' | 'disabled';
  controllerId: string | null;
  windows: number;
  windowMs: number;
  policyTickMs: number;
  ticks: number;
  decisions: { quote: number; hold: number; pull: number; policyErrors: number };
  orders: {
    proposed: number;
    submitted: number;
    rejectedByRisk: number;
    rejectedByVenue: number;
    cancelsRequested: number;
    cancelsEffective: number;
    cancelsTooLate: number;
    cancelFillRaces: number;
  };
  fills: {
    count: number;
    qty: Decimal;
    buyQty: Decimal;
    sellQty: Decimal;
    buyNotional: Decimal;
    sellNotional: Decimal;
    partial: number;
    tradeThrough: number;
    queueExhausted: number;
    lateAfterCancel: number;
    /** Prints at our price that could not have filled us on venue time, by reason. */
    ineligible: number;
    ineligibleByReason: { predatesActivation: number; atActivationInstant: number; afterCancellation: number };
    uncertain: number;
  };
  fillUncertainty: { model: string; note: string; queueConsumedWithoutFill: number };
  outcomes: OutcomeHorizonStats[];
  outcomesPendingAtEnd: number;
  outcomesUnmeasurable: number;
  portfolio: ValuationWire & { maxAbsInventory: Decimal; initialCash: Decimal };
  instructions: {
    accepted: number;
    rejectedLate: number;
    rejectedFailed: number;
    rejectedInvalid: number;
    finalVersion: number;
    history: Array<{
      version: number;
      controllerId: string;
      basedOnWindow: number;
      effectiveFrom: number;
      readyAt: number;
      params: SteeringParams;
      reason: string;
    }>;
  };
  risk: { killSwitchTripped: boolean; killSwitchAt: number | null; maxPosition: Decimal; maxLoss: Decimal; positionOverruns: number };
  observations: { accepted: number; rejected: number; notReached: number };
  windowRows: WindowRow[];
  assumptions: string[];
  ledger: { entries: number; headHash: string };
}
