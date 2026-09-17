import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE, RiskGate, parseMoney, parsePrice, parseQty } from '../src/index.js';

describe('risk gate', () => {
  const gate = () => new RiskGate({ ...DEFAULT_BASE.risk, maxPosition: parseQty('2'), maxOrderQty: parseQty('1.5'), maxLoss: parseMoney('10') });

  it('counts open orders toward the position limit', () => {
    const g = gate();
    const ok = g.checkOrder({ side: 'buy', price: parsePrice('100'), qty: parseQty('1') }, { inventory: parseQty('0.5'), openBuyQty: parseQty('0.5'), openSellQty: 0n });
    expect(ok).toEqual({ ok: true });
    const blocked = g.checkOrder({ side: 'buy', price: parsePrice('100'), qty: parseQty('1') }, { inventory: parseQty('0.5'), openBuyQty: parseQty('0.6'), openSellQty: 0n });
    expect(blocked).toMatchObject({ ok: false, reason: 'position_limit' });
    const short = g.checkOrder({ side: 'sell', price: parsePrice('100'), qty: parseQty('1') }, { inventory: parseQty('-1.5'), openBuyQty: 0n, openSellQty: 0n });
    expect(short).toMatchObject({ ok: false, reason: 'position_limit' });
  });

  it('rejects malformed and oversized orders', () => {
    const g = gate();
    const ctx = { inventory: 0n, openBuyQty: 0n, openSellQty: 0n };
    expect(g.checkOrder({ side: 'buy', price: parsePrice('100'), qty: parseQty('1.6') }, ctx)).toMatchObject({ reason: 'order_size_limit' });
    expect(g.checkOrder({ side: 'buy', price: parsePrice('100.005'), qty: parseQty('1') }, ctx)).toMatchObject({ reason: 'invalid_price' });
    expect(g.checkOrder({ side: 'buy', price: parsePrice('100'), qty: 1n }, ctx)).toMatchObject({ reason: 'invalid_qty' });
  });

  it('trips the kill switch once and rejects everything afterwards', () => {
    const g = gate();
    expect(g.checkLoss(parseMoney('-9.99'), 1)).toBe(false);
    expect(g.checkLoss(parseMoney('-10'), 2)).toBe(true);
    expect(g.checkLoss(parseMoney('-50'), 3)).toBe(false); // already tripped
    expect(g.killSwitchAt).toBe(2);
    const ctx = { inventory: 0n, openBuyQty: 0n, openSellQty: 0n };
    expect(g.checkOrder({ side: 'buy', price: parsePrice('100'), qty: parseQty('1') }, ctx)).toMatchObject({ reason: 'kill_switch_active' });
  });
});
