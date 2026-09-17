import type { FastPolicy, PolicyDecision, PolicyInput } from './types.js';

/** Baseline: never quotes. */
export class NoTradePolicy implements FastPolicy {
  readonly id = 'no-trade';
  decide(_input: PolicyInput): PolicyDecision {
    return { intent: 'hold', bid: null, ask: null, reason: 'no-trade baseline' };
  }
}
