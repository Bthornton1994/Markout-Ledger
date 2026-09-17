import { describe, expect, it } from 'vitest';
import { MONEY_SCALE, Portfolio, mulberry32, notional, parseMoney, parsePrice, parseQty, signBig, absBig } from '../src/index.js';

function checkIdentity(p: Portfolio, mark: { bestBid: bigint; bestAsk: bigint } | null): void {
  const v = p.valuation(mark);
  expect(v.equity - p.initialCash).toBe(v.netPnl);
  expect(v.netPnl).toBe(v.grossRealized + v.unrealized - v.feesPaid - v.txCostsPaid);
  expect(v.equity).toBe(v.cash + v.inventoryValue);
  if (v.inventory === 0n) expect(v.unrealized).toBe(0n);
}

describe('portfolio accounting', () => {
  it('realizes P&L on a partial close of a long with average-cost basis', () => {
    const p = new Portfolio(parseMoney('1000'));
    p.applyFill('buy', parsePrice('100'), parseQty('2'), parseMoney('0.04'));
    expect(p.inventory).toBe(parseQty('2'));
    expect(p.positionCost).toBe(parseMoney('200'));
    expect(p.cash).toBe(parseMoney('1000') - parseMoney('200') - parseMoney('0.04'));
    const app = p.applyFill('sell', parsePrice('101'), parseQty('1'), parseMoney('0.0202'));
    expect(app.closedQty).toBe(parseQty('1'));
    expect(app.realizedDelta).toBe(parseMoney('1')); // (101 - 100) * 1
    expect(p.grossRealized).toBe(parseMoney('1'));
    expect(p.positionCost).toBe(parseMoney('100'));
    checkIdentity(p, { bestBid: parsePrice('100.5'), bestAsk: parsePrice('100.6') });
    const v = p.valuation({ bestBid: parsePrice('100.5'), bestAsk: parsePrice('100.6') });
    expect(v.markPrice).toBe(parsePrice('100.5')); // long marks at bid
    expect(v.unrealized).toBe(parseMoney('0.5'));
    expect(v.feesPaid).toBe(parseMoney('0.0602'));
  });

  it('handles a position flip in a single fill', () => {
    const p = new Portfolio(parseMoney('1000'));
    p.applyFill('buy', parsePrice('100'), parseQty('1'), 0n);
    const app = p.applyFill('sell', parsePrice('102'), parseQty('3'), 0n);
    expect(app.closedQty).toBe(parseQty('1'));
    expect(app.openedQty).toBe(parseQty('2'));
    expect(app.realizedDelta).toBe(parseMoney('2'));
    expect(p.inventory).toBe(parseQty('-2'));
    expect(p.positionCost).toBe(-parseMoney('204')); // short: received 204 for 2 units
    const v = p.valuation({ bestBid: parsePrice('101'), bestAsk: parsePrice('101.5') });
    expect(v.markPrice).toBe(parsePrice('101.5')); // short marks at ask
    expect(v.unrealized).toBe(parseMoney('1')); // (102 - 101.5) * 2
    checkIdentity(p, { bestBid: parsePrice('101'), bestAsk: parsePrice('101.5') });
  });

  it('keeps the net P&L identity exact over random fill sequences', () => {
    const rng = mulberry32(1234);
    for (let trial = 0; trial < 50; trial++) {
      const p = new Portfolio(parseMoney('5000'));
      let expectedCash = p.initialCash;
      let expectedInv = 0n;
      let fees = 0n;
      let tx = 0n;
      for (let i = 0; i < 40; i++) {
        const side = rng.chance(0.5) ? 'buy' : 'sell';
        const price = parsePrice((90 + rng.next() * 20).toFixed(6));
        const qty = parseQty((0.001 + rng.next() * 2).toFixed(6));
        const n = notional(price, qty);
        const fee = (n * 2n + 9_999n) / 10_000n;
        p.applyFill(side, price, qty, fee);
        expectedCash += side === 'buy' ? -n : n;
        expectedCash -= fee;
        expectedInv += side === 'buy' ? qty : -qty;
        fees += fee;
        if (rng.chance(0.3)) {
          const c = parseMoney('0.005');
          p.applyTxCost(c);
          expectedCash -= c;
          tx += c;
        }
        const mid = parsePrice((90 + rng.next() * 20).toFixed(6));
        checkIdentity(p, { bestBid: mid - 10_000n, bestAsk: mid + 10_000n });
        checkIdentity(p, null);
      }
      expect(p.cash).toBe(expectedCash);
      expect(p.inventory).toBe(expectedInv);
      expect(p.feesPaid).toBe(fees);
      expect(p.txCostsPaid).toBe(tx);
      if (expectedInv !== 0n) expect(signBig(p.positionCost)).toBe(signBig(expectedInv));
      expect(absBig(p.maxAbsInventory) >= absBig(expectedInv)).toBe(true);
    }
  });

  it('values inventory at cost when no book has ever been seen', () => {
    const p = new Portfolio(10n * MONEY_SCALE);
    p.applyFill('buy', parsePrice('1'), parseQty('1'), 0n);
    const v = p.valuation(null);
    expect(v.markPrice).toBeNull();
    expect(v.unrealized).toBe(0n);
    expect(v.netPnl).toBe(0n);
  });
});
