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

  it('rounds the cost removed by a partial close half away from zero, and a full close removes the rest exactly', () => {
    const long = new Portfolio(parseMoney('1000'));
    long.applyFill('buy', parsePrice('100'), parseQty('1'), 0n);
    long.applyFill('buy', parsePrice('100.000001'), parseQty('1'), 0n);
    // removedCost = 200.000001 * 1/2 = 100.0000005, rounded to 100.000001
    expect(long.applyFill('sell', parsePrice('101'), parseQty('1'), 0n).realizedDelta).toBe(parseMoney('0.999999'));
    expect(long.positionCost).toBe(parseMoney('100'));
    long.applyFill('sell', parsePrice('101'), parseQty('1'), 0n);
    expect(long.positionCost).toBe(0n);
    expect(long.grossRealized).toBe(parseMoney('1.999999')); // 202 - 200.000001: the split rounding cancels

    const short = new Portfolio(parseMoney('1000'));
    short.applyFill('sell', parsePrice('100'), parseQty('1'), 0n);
    short.applyFill('sell', parsePrice('100.000001'), parseQty('1'), 0n);
    // removedCost = -200.000001 * 1/2 = -100.0000005, rounded to -100.000001
    expect(short.applyFill('buy', parsePrice('99'), parseQty('1'), 0n).realizedDelta).toBe(parseMoney('1.000001'));
    expect(short.positionCost).toBe(-parseMoney('100'));
  });

  it('counts fills, per-side quantity and notional, and the largest absolute inventory after any fill', () => {
    const p = new Portfolio(parseMoney('1000'));
    p.applyFill('buy', parsePrice('101'), parseQty('0.5'), 0n);
    p.applyFill('buy', parsePrice('100'), parseQty('0.5'), 0n);
    p.applyFill('sell', parsePrice('102'), parseQty('3'), 0n);
    expect(p.fillCount).toBe(3);
    expect(p.buyQty).toBe(parseQty('1'));
    expect(p.sellQty).toBe(parseQty('3'));
    expect(p.buyNotional).toBe(parseMoney('100.5'));
    expect(p.sellNotional).toBe(parseMoney('306'));
    expect(p.maxAbsInventory).toBe(parseQty('2')); // reached by the flip, after the fill
  });

  it('rejects invalid inputs before changing any state', () => {
    expect(() => new Portfolio(-1n)).toThrow(RangeError);
    const p = new Portfolio(parseMoney('1000'));
    p.applyFill('buy', parsePrice('100'), parseQty('1'), parseMoney('0.02'));
    p.applyTxCost(parseMoney('0.005'));
    const state = () => ({
      cash: p.cash,
      inventory: p.inventory,
      positionCost: p.positionCost,
      grossRealized: p.grossRealized,
      feesPaid: p.feesPaid,
      txCostsPaid: p.txCostsPaid,
      fillCount: p.fillCount,
      buyQty: p.buyQty,
      sellQty: p.sellQty,
    });
    const before = state();
    const invalid: Array<[string, () => unknown]> = [
      ['zero qty', () => p.applyFill('sell', parsePrice('100'), 0n, 0n)],
      ['negative qty', () => p.applyFill('sell', parsePrice('100'), -1n, 0n)],
      ['zero price', () => p.applyFill('sell', 0n, parseQty('1'), 0n)],
      ['negative fee (rebates are not modelled)', () => p.applyFill('sell', parsePrice('100'), parseQty('1'), -1n)],
      ['negative tx cost', () => p.applyTxCost(-1n)],
    ];
    for (const [name, call] of invalid) {
      expect(call, name).toThrow(RangeError);
      expect(state(), name).toEqual(before);
    }
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
    expect(v.markMethod).toBe('no_book_seen:inventory_at_cost');
    expect(v.inventoryValue).toBe(p.positionCost);
    expect(v.unrealized).toBe(0n);
    expect(v.netPnl).toBe(0n);

    const s = new Portfolio(parseMoney('1000'));
    s.applyFill('sell', parsePrice('100'), parseQty('2'), 0n);
    const vs = s.valuation(null);
    expect(vs.markMethod).toBe('no_book_seen:inventory_at_cost');
    expect(vs.inventoryValue).toBe(-parseMoney('200'));
    expect(vs.unrealized).toBe(0n);
    checkIdentity(s, null);
  });

  it('values with the last known book, and says so, when the latest book is missing', () => {
    const p = new Portfolio(parseMoney('1000'));
    p.applyFill('buy', parsePrice('100'), parseQty('2'), 0n);
    p.valuation({ bestBid: parsePrice('98'), bestAsk: parsePrice('99') });
    const book = { bestBid: parsePrice('101'), bestAsk: parsePrice('102') };
    const live = p.valuation(book);
    const stale = p.valuation(null);
    expect(live.markMethod).toBe('conservative:long@bid,short@ask');
    expect(stale.markMethod).toBe('conservative:long@bid,short@ask(last_known_book)');
    expect({ ...stale, markMethod: '' }).toEqual({ ...live, markMethod: '' });
    expect(stale.markPrice).toBe(parsePrice('101')); // the newest book, long at its bid
    expect(stale.unrealized).toBe(parseMoney('2'));

    // A fill after the last book flips the side; the stale book still marks short at its ask.
    p.applyFill('sell', parsePrice('101'), parseQty('3'), 0n);
    const flipped = p.valuation(null);
    expect(flipped.markMethod).toBe('conservative:long@bid,short@ask(last_known_book)');
    expect(flipped.markPrice).toBe(parsePrice('102'));
    expect(flipped.inventoryValue).toBe(-parseMoney('102'));
    checkIdentity(p, null);
  });

  it('values flat inventory at zero and reports the midpoint rounded down as the mark', () => {
    const p = new Portfolio(parseMoney('1000'));
    p.applyFill('buy', parsePrice('100'), parseQty('1'), 0n);
    p.applyFill('sell', parsePrice('100.5'), parseQty('1'), 0n);
    const v = p.valuation({ bestBid: 100_000_000n, bestAsk: 100_000_003n });
    expect(v.inventory).toBe(0n);
    expect(v.markPrice).toBe(100_000_001n); // (bid + ask) / 2 = 100.0000015, rounded down
    expect(v.inventoryValue).toBe(0n);
    expect(v.unrealized).toBe(0n);
    expect(v.netPnl).toBe(parseMoney('0.5'));
    checkIdentity(p, null);
  });
});
