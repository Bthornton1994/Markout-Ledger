/**
 * Simple symmetric quoting policy steered by the active instruction.
 *
 *   halfSpreadBps = baseHalfSpreadBps * spreadMultiplier
 *   skewBps       = inventorySkewBps * inventory / maxPosition          (positive when long)
 *   bid = floorTick(mid * (1 - (halfSpread + skew)/1e4)), ask = ceilTick(mid * (1 + (halfSpread - skew)/1e4))
 *   qty = floorLot(baseQuoteQty * sizeMultiplier)
 * Sides are dropped when the instruction disallows them or inventory is at the allowed fraction.
 * Quotes are re-used (not replaced) when the desired price is within requoteThresholdTicks of the resting price.
 */
import {
  BPS_DENOM,
  MILLI_DENOM,
  absBig,
  applyMilli,
  ceilToIncrement,
  floorToIncrement,
  maxBig,
  minBig,
  mulDivHalfUp,
} from '../core/money.js';
import type { FastPolicy, PolicyDecision, PolicyInput, QuoteIntent, RestingView } from './types.js';

export interface MarketMakerConfig {
  baseHalfSpreadBps: bigint;
  baseQuoteQty: bigint;
  maxBookAgeMs: number;
  requoteThresholdTicks: bigint;
  tickSize: bigint;
  lotSize: bigint;
}

export class MarketMakerPolicy implements FastPolicy {
  readonly id: string;

  constructor(
    readonly config: MarketMakerConfig,
    id = 'mm-symmetric-v1',
  ) {
    this.id = id;
  }

  decide(input: PolicyInput): PolicyDecision {
    const { book, bookAgeMs, instruction, inventory, maxPosition } = input;
    if (!book || bookAgeMs === null || bookAgeMs > this.config.maxBookAgeMs) {
      return { intent: 'pull', bid: null, ask: null, reason: book ? `book stale (${bookAgeMs}ms)` : 'no book' };
    }
    const p = instruction.params;
    const tick = this.config.tickSize;
    const mid = book.mid;

    const halfSpreadBps = mulDivHalfUp(this.config.baseHalfSpreadBps, BigInt(p.spreadMultiplierMilli), MILLI_DENOM);
    // skew in bps scaled by inventory utilisation (signed): +ve when long -> shift quotes down
    const skewBps = maxPosition > 0n ? mulDivHalfUp(BigInt(p.inventorySkewBps), inventory, maxPosition) : 0n;
    const bidOffset = mulDivHalfUp(mid, halfSpreadBps + skewBps, BPS_DENOM);
    const askOffset = mulDivHalfUp(mid, halfSpreadBps - skewBps, BPS_DENOM);
    let bidPx = floorToIncrement(mid - bidOffset, tick);
    let askPx = ceilToIncrement(mid + askOffset, tick);
    // Post-only guard: never cross the touch.
    bidPx = minBig(bidPx, book.bestAsk - tick);
    askPx = maxBig(askPx, book.bestBid + tick);

    const qty = floorToIncrement(applyMilli(this.config.baseQuoteQty, BigInt(p.sizeMultiplierMilli)), this.config.lotSize);
    const allowedInv = applyMilli(maxPosition, BigInt(p.maxInventoryFractionMilli));

    const wantBid = (p.quoteSides === 'both' || p.quoteSides === 'bid_only') && qty > 0n && inventory + qty <= allowedInv;
    const wantAsk = (p.quoteSides === 'both' || p.quoteSides === 'ask_only') && qty > 0n && -inventory + qty <= allowedInv;

    const bid = wantBid ? this.reuse({ price: bidPx, qty }, input.resting.bid) : null;
    const ask = wantAsk ? this.reuse({ price: askPx, qty }, input.resting.ask) : null;
    if (!bid && !ask) {
      return { intent: 'quote', bid: null, ask: null, reason: `no side allowed (sides=${p.quoteSides}, inv=${inventory}, allowed=${allowedInv}, qty=${qty})` };
    }
    return {
      intent: 'quote',
      bid,
      ask,
      reason: `halfSpread=${halfSpreadBps}bps skew=${skewBps}bps sizeMilli=${p.sizeMultiplierMilli} v${instruction.version}`,
    };
  }

  private reuse(desired: QuoteIntent, resting: RestingView | null): QuoteIntent {
    if (!resting || resting.qty !== desired.qty) return desired;
    const diff = absBig(resting.price - desired.price);
    if (diff < this.config.requoteThresholdTicks * this.config.tickSize) {
      return { price: resting.price, qty: resting.qty };
    }
    return desired;
  }
}
