/**
 * Risk gate: every proposed order passes through here before it reaches the execution model.
 * Open (not yet cancelled) orders count toward exposure, so a replace-in-flight is charged
 * against the limit until the old order's cancel is effective. This is deliberately strict.
 */
import { type Decimal, absBig, fmtMoney, fmtQty } from '../core/money.js';

export interface RiskConfig {
  /** Absolute inventory cap in base units (QTY_SCALE). Includes open order exposure. */
  maxPosition: bigint;
  /** Max single order quantity (QTY_SCALE). */
  maxOrderQty: bigint;
  /** Net P&L floor: if netPnl <= -maxLoss the kill switch trips (MONEY_SCALE). */
  maxLoss: bigint;
  tickSize: bigint;
  lotSize: bigint;
}

export interface RiskConfigWire {
  maxPosition: Decimal;
  maxOrderQty: Decimal;
  maxLoss: Decimal;
  tickSize: Decimal;
  lotSize: Decimal;
}

export type RiskRejectReason =
  | 'kill_switch_active'
  | 'order_size_limit'
  | 'invalid_qty'
  | 'invalid_price'
  | 'position_limit';

export interface OrderCheckContext {
  inventory: bigint;
  /** Sum of remaining qty on open buy orders (pending, live, or cancel pending). */
  openBuyQty: bigint;
  openSellQty: bigint;
}

export type RiskVerdict = { ok: true } | { ok: false; reason: RiskRejectReason; detail: string };

export class RiskGate {
  killSwitch = false;
  killSwitchAt: number | null = null;
  killSwitchDetail: string | null = null;

  constructor(readonly config: RiskConfig) {
    if (config.maxPosition <= 0n || config.maxOrderQty <= 0n || config.maxLoss <= 0n) {
      throw new RangeError('risk limits must be positive');
    }
  }

  checkOrder(order: { side: 'buy' | 'sell'; price: bigint; qty: bigint }, ctx: OrderCheckContext): RiskVerdict {
    if (this.killSwitch) {
      return { ok: false, reason: 'kill_switch_active', detail: this.killSwitchDetail ?? 'kill switch active' };
    }
    if (order.qty <= 0n || order.qty % this.config.lotSize !== 0n) {
      return { ok: false, reason: 'invalid_qty', detail: `qty ${fmtQty(order.qty)} not a positive multiple of lot` };
    }
    if (order.price <= 0n || order.price % this.config.tickSize !== 0n) {
      return { ok: false, reason: 'invalid_price', detail: `price not a positive multiple of tick` };
    }
    if (order.qty > this.config.maxOrderQty) {
      return { ok: false, reason: 'order_size_limit', detail: `qty ${fmtQty(order.qty)} > max ${fmtQty(this.config.maxOrderQty)}` };
    }
    const projected =
      order.side === 'buy' ? ctx.inventory + ctx.openBuyQty + order.qty : ctx.inventory - ctx.openSellQty - order.qty;
    if (absBig(projected) > this.config.maxPosition) {
      return {
        ok: false,
        reason: 'position_limit',
        detail: `projected exposure ${fmtQty(projected)} exceeds max position ${fmtQty(this.config.maxPosition)} (inventory ${fmtQty(ctx.inventory)}, open buys ${fmtQty(ctx.openBuyQty)}, open sells ${fmtQty(ctx.openSellQty)})`,
      };
    }
    return { ok: true };
  }

  /** Returns true when the kill switch trips on this call (not when it was already tripped). */
  checkLoss(netPnl: bigint, now: number): boolean {
    if (this.killSwitch) return false;
    if (netPnl <= -this.config.maxLoss) {
      this.killSwitch = true;
      this.killSwitchAt = now;
      this.killSwitchDetail = `net P&L ${fmtMoney(netPnl)} breached loss limit -${fmtMoney(this.config.maxLoss)} at ${now}`;
      return true;
    }
    return false;
  }

  toWire(): RiskConfigWire {
    return {
      maxPosition: fmtQty(this.config.maxPosition),
      maxOrderQty: fmtQty(this.config.maxOrderQty),
      maxLoss: fmtMoney(this.config.maxLoss),
      tickSize: fmtMoney(this.config.tickSize),
      lotSize: fmtQty(this.config.lotSize),
    };
  }
}
