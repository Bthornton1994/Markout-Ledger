import { describe, expect, it } from 'vitest';
import {
  MONEY_SCALE,
  PRICE_SCALE,
  QTY_SCALE,
  bpsOf,
  ceilToIncrement,
  feeOn,
  floorToIncrement,
  formatDecimal,
  mulDivHalfUp,
  notional,
  parseDecimal,
} from '../src/index.js';

describe('fixed-point money', () => {
  it('round-trips decimal strings exactly', () => {
    for (const s of ['0.000000', '100.250000', '-0.000123', '12345678.900000']) {
      expect(formatDecimal(parseDecimal(s, MONEY_SCALE), MONEY_SCALE)).toBe(s);
    }
    expect(formatDecimal(parseDecimal('1.5', PRICE_SCALE), PRICE_SCALE)).toBe('1.500000');
  });

  it('refuses silent precision loss', () => {
    expect(() => parseDecimal('1.0000001', MONEY_SCALE)).toThrow(/precision/);
    expect(parseDecimal('1.0000000', MONEY_SCALE)).toBe(1_000_000n);
    expect(() => parseDecimal('abc')).toThrow(/invalid decimal/);
  });

  it('computes notional in money units with half-up rounding', () => {
    expect(notional(parseDecimal('100.00', PRICE_SCALE), parseDecimal('1.5', QTY_SCALE))).toBe(parseDecimal('150.00', MONEY_SCALE));
    // 0.000001 * 0.5 = 0.0000005 -> rounds half up to 0.000001
    expect(notional(1n, 500_000n)).toBe(1n);
    expect(notional(1n, 499_999n)).toBe(0n);
  });

  it('rounds fees up, never down', () => {
    const n = parseDecimal('100.000001', MONEY_SCALE);
    // 2 bps of 100.000001 = 0.0200000002 -> ceil to 0.020001
    expect(feeOn(n, 2n)).toBe(parseDecimal('0.020001', MONEY_SCALE));
    expect(feeOn(0n, 2n)).toBe(0n);
    expect(() => feeOn(n, -1n)).toThrow();
  });

  it('rounds to increments in the expected direction for negatives too', () => {
    expect(floorToIncrement(15n, 10n)).toBe(10n);
    expect(floorToIncrement(-15n, 10n)).toBe(-20n);
    expect(ceilToIncrement(15n, 10n)).toBe(20n);
    expect(ceilToIncrement(-15n, 10n)).toBe(-10n);
  });

  it('mulDivHalfUp is symmetric around zero and bpsOf handles zero', () => {
    expect(mulDivHalfUp(7n, 1n, 2n)).toBe(4n);
    expect(mulDivHalfUp(-7n, 1n, 2n)).toBe(-4n);
    expect(bpsOf(1n, 0n)).toBe(0n);
    expect(bpsOf(-5n, 10_000n)).toBe(-5n);
  });
});
