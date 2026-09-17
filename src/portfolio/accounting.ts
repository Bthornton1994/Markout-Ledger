/**
 * Portfolio accounting in integer money. See docs/ACCOUNTING.md for the equations.
 *
 * Invariant (exact, checked in tests):
 *   equity(mark) - initialCash == grossRealized + unrealized(mark) - feesPaid - txCostsPaid
 * where
 *   equity(mark)     = cash + inventoryValue(mark)
 *   inventoryValue   = sign(inventory) * notional(mark, |inventory|)
 *   unrealized(mark) = inventoryValue(mark) - positionCost
 *   positionCost     = signed cash outlay attributable to the currently open inventory
 */
import { type Decimal, absBig, fmtMoney, fmtPrice, fmtQty, maxBig, minBig, mulDivHalfUp, notional, signBig } from '../core/money.js';

import type { Side } from '../core/side.js';

export interface FillApplication {
  notional: bigint;
  fee: bigint;
  closedQty: bigint;
  openedQty: bigint;
  realizedDelta: bigint;
  inventoryAfter: bigint;
  cashAfter: bigint;
}

export interface Mark {
  bestBid: bigint;
  bestAsk: bigint;
}

export interface Valuation {
  cash: bigint;
  inventory: bigint;
  positionCost: bigint;
  markPrice: bigint | null;
  markMethod: string;
  inventoryValue: bigint;
  unrealized: bigint;
  grossRealized: bigint;
  feesPaid: bigint;
  txCostsPaid: bigint;
  equity: bigint;
  netPnl: bigint;
}

export interface ValuationWire {
  cash: Decimal;
  inventory: Decimal;
  positionCost: Decimal;
  markPrice: Decimal | null;
  markMethod: string;
  inventoryValue: Decimal;
  unrealized: Decimal;
  grossRealized: Decimal;
  feesPaid: Decimal;
  txCostsPaid: Decimal;
  equity: Decimal;
  netPnl: Decimal;
}

export function valuationToWire(v: Valuation): ValuationWire {
  return {
    cash: fmtMoney(v.cash),
    inventory: fmtQty(v.inventory),
    positionCost: fmtMoney(v.positionCost),
    markPrice: v.markPrice === null ? null : fmtPrice(v.markPrice),
    markMethod: v.markMethod,
    inventoryValue: fmtMoney(v.inventoryValue),
    unrealized: fmtMoney(v.unrealized),
    grossRealized: fmtMoney(v.grossRealized),
    feesPaid: fmtMoney(v.feesPaid),
    txCostsPaid: fmtMoney(v.txCostsPaid),
    equity: fmtMoney(v.equity),
    netPnl: fmtMoney(v.netPnl),
  };
}

export class Portfolio {
  readonly initialCash: bigint;
  cash: bigint;
  inventory = 0n;
  positionCost = 0n;
  grossRealized = 0n;
  feesPaid = 0n;
  txCostsPaid = 0n;
  fillCount = 0;
  buyQty = 0n;
  sellQty = 0n;
  buyNotional = 0n;
  sellNotional = 0n;
  maxAbsInventory = 0n;
  /** Last mark used for valuation, kept so a valuation is possible when the book is missing. */
  private lastMark: Mark | null = null;

  constructor(initialCash: bigint) {
    if (initialCash < 0n) throw new RangeError('initial cash must be non-negative');
    this.initialCash = initialCash;
    this.cash = initialCash;
  }

  applyFill(side: Side, price: bigint, qty: bigint, fee: bigint): FillApplication {
    if (qty <= 0n) throw new RangeError('fill qty must be positive');
    if (price <= 0n) throw new RangeError('fill price must be positive');
    if (fee < 0n) throw new RangeError('fee must be non-negative');
    const sign = side === 'buy' ? 1n : -1n;
    const n = notional(price, qty);

    this.cash -= sign * n;
    this.cash -= fee;
    this.feesPaid += fee;

    let realizedDelta = 0n;
    let closedQty = 0n;
    let openedQty = qty;
    const invBefore = this.inventory;

    if (invBefore === 0n || signBig(invBefore) === sign) {
      this.positionCost += sign * n;
    } else {
      const absInv = absBig(invBefore);
      closedQty = minBig(qty, absInv);
      openedQty = qty - closedQty;
      const nClose = closedQty === qty ? n : notional(price, closedQty);
      const nOpen = n - nClose;
      const removedCost = closedQty === absInv ? this.positionCost : mulDivHalfUp(this.positionCost, closedQty, absInv);
      realizedDelta = -sign * nClose - removedCost;
      this.grossRealized += realizedDelta;
      this.positionCost = this.positionCost - removedCost + sign * nOpen;
    }

    this.inventory += sign * qty;
    this.maxAbsInventory = maxBig(this.maxAbsInventory, absBig(this.inventory));
    this.fillCount += 1;
    if (side === 'buy') {
      this.buyQty += qty;
      this.buyNotional += n;
    } else {
      this.sellQty += qty;
      this.sellNotional += n;
    }
    if (this.inventory === 0n && this.positionCost !== 0n) {
      throw new Error(`accounting invariant broken: flat inventory with positionCost ${this.positionCost}`);
    }
    return { notional: n, fee, closedQty, openedQty, realizedDelta, inventoryAfter: this.inventory, cashAfter: this.cash };
  }

  applyTxCost(amount: bigint): bigint {
    if (amount < 0n) throw new RangeError('tx cost must be non-negative');
    this.cash -= amount;
    this.txCostsPaid += amount;
    return this.cash;
  }

  /**
   * Conservative mark: long inventory at best bid, short at best ask (liquidation value).
   * With no book ever seen, inventory is valued at cost (unrealized 0) and markPrice is null.
   */
  valuation(mark: Mark | null): Valuation {
    if (mark) this.lastMark = mark;
    const m = mark ?? this.lastMark;
    let markPrice: bigint | null = null;
    let markMethod = 'no_book_seen:inventory_at_cost';
    let inventoryValue = this.positionCost;
    if (m) {
      markPrice = this.inventory > 0n ? m.bestBid : this.inventory < 0n ? m.bestAsk : (m.bestBid + m.bestAsk) / 2n;
      markMethod = mark ? 'conservative:long@bid,short@ask' : 'conservative:long@bid,short@ask(last_known_book)';
      inventoryValue = signBig(this.inventory) * notional(markPrice, absBig(this.inventory));
    }
    const unrealized = inventoryValue - this.positionCost;
    const equity = this.cash + inventoryValue;
    return {
      cash: this.cash,
      inventory: this.inventory,
      positionCost: this.positionCost,
      markPrice,
      markMethod,
      inventoryValue,
      unrealized,
      grossRealized: this.grossRealized,
      feesPaid: this.feesPaid,
      txCostsPaid: this.txCostsPaid,
      equity,
      netPnl: equity - this.initialCash,
    };
  }
}
