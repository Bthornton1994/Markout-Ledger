/**
 * Fixed-point monetary arithmetic on bigint.
 *
 * All prices, quantities and money values are integers scaled by a power of ten.
 * No floating point is used anywhere in accounting, execution or risk.
 *
 *   price:  quote-per-base, scaled by PRICE_SCALE  (1e-6 quote)
 *   qty:    base units,      scaled by QTY_SCALE    (1e-6 base)
 *   money:  quote units,     scaled by MONEY_SCALE  (1e-6 quote)
 *
 * notional(price, qty) = round_half_up(price * qty / QTY_SCALE), which lands in MONEY_SCALE units
 * because PRICE_SCALE === MONEY_SCALE.
 */

export const PRICE_SCALE = 1_000_000n;
export const QTY_SCALE = 1_000_000n;
export const MONEY_SCALE = 1_000_000n;
export const BPS_DENOM = 10_000n;
export const MILLI_DENOM = 1_000n;

/** A decimal string such as "100.250000" or "-0.000123". Used on the wire and in the ledger. */
export type Decimal = string;

function assertPositiveDivisor(d: bigint): void {
  if (d <= 0n) throw new RangeError('divisor must be positive');
}

/** a * b / d, rounded half away from zero. */
export function mulDivHalfUp(a: bigint, b: bigint, d: bigint): bigint {
  assertPositiveDivisor(d);
  const p = a * b;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const q = (abs + d / 2n) / d;
  return neg ? -q : q;
}

/** a * b / d, rounded toward +infinity. Product must be non-negative. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  assertPositiveDivisor(d);
  const p = a * b;
  if (p < 0n) throw new RangeError('mulDivCeil expects a non-negative product');
  return (p + d - 1n) / d;
}

/** a * b / d, rounded toward -infinity. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  assertPositiveDivisor(d);
  const p = a * b;
  if (p >= 0n) return p / d;
  return -((-p + d - 1n) / d);
}

/** Notional value of `qty` base units at `price`, in MONEY_SCALE units. */
export function notional(price: bigint, qty: bigint): bigint {
  if (price < 0n || qty < 0n) throw new RangeError('price and qty must be non-negative');
  return mulDivHalfUp(price, qty, QTY_SCALE);
}

/** Fee on a notional at `feeBps` basis points, rounded UP (conservative). */
export function feeOn(notionalValue: bigint, feeBps: bigint): bigint {
  if (feeBps < 0n) throw new RangeError('fee bps must be non-negative (rebates are not modeled)');
  if (notionalValue < 0n) throw new RangeError('notional must be non-negative');
  return mulDivCeil(notionalValue, feeBps, BPS_DENOM);
}

export function applyBps(value: bigint, bps: bigint): bigint {
  return mulDivHalfUp(value, bps, BPS_DENOM);
}

export function applyMilli(value: bigint, milli: bigint): bigint {
  return mulDivHalfUp(value, milli, MILLI_DENOM);
}

/** Basis points of `part` relative to `whole`, rounded half up. Returns 0n when whole is 0. */
export function bpsOf(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  const absWhole = whole < 0n ? -whole : whole;
  return mulDivHalfUp(part, BPS_DENOM, absWhole);
}

export function decimalsOf(scale: bigint): number {
  const s = scale.toString();
  if (!/^10*$/.test(s)) throw new RangeError(`scale must be a power of ten, got ${s}`);
  return s.length - 1;
}

/**
 * Parse a decimal string into a scaled bigint. Throws if the string carries more
 * precision than the scale can represent (no silent truncation).
 */
export function parseDecimal(text: string, scale: bigint = MONEY_SCALE): bigint {
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`invalid decimal: ${JSON.stringify(text)}`);
  const decimals = decimalsOf(scale);
  const frac = m[3] ?? '';
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) {
    throw new Error(`decimal ${text} exceeds precision of ${decimals} places`);
  }
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, '0');
  const v = BigInt(m[2] ?? '0') * scale + BigInt(fracPadded || '0');
  return m[1] === '-' ? -v : v;
}

/** Format a scaled bigint as a decimal string with the full precision of the scale. */
export function formatDecimal(value: bigint, scale: bigint = MONEY_SCALE): Decimal {
  const decimals = decimalsOf(scale);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const intPart = abs / scale;
  const fracPart = abs % scale;
  const s = decimals === 0 ? intPart.toString() : `${intPart}.${fracPart.toString().padStart(decimals, '0')}`;
  return neg ? `-${s}` : s;
}

export const fmtPrice = (v: bigint): Decimal => formatDecimal(v, PRICE_SCALE);
export const fmtQty = (v: bigint): Decimal => formatDecimal(v, QTY_SCALE);
export const fmtMoney = (v: bigint): Decimal => formatDecimal(v, MONEY_SCALE);
export const parsePrice = (s: string): bigint => parseDecimal(s, PRICE_SCALE);
export const parseQty = (s: string): bigint => parseDecimal(s, QTY_SCALE);
export const parseMoney = (s: string): bigint => parseDecimal(s, MONEY_SCALE);

/** Round toward -infinity to a multiple of `inc`. */
export function floorToIncrement(value: bigint, inc: bigint): bigint {
  assertPositiveDivisor(inc);
  if (value >= 0n) return value - (value % inc);
  return -(((-value) + inc - 1n) / inc) * inc;
}

/** Round toward +infinity to a multiple of `inc`. */
export function ceilToIncrement(value: bigint, inc: bigint): bigint {
  assertPositiveDivisor(inc);
  if (value >= 0n) return ((value + inc - 1n) / inc) * inc;
  return -((-value) - ((-value) % inc));
}

export const absBig = (v: bigint): bigint => (v < 0n ? -v : v);
export const signBig = (v: bigint): bigint => (v > 0n ? 1n : v < 0n ? -1n : 0n);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const clampBig = (v: bigint, lo: bigint, hi: bigint): bigint => (v < lo ? lo : v > hi ? hi : v);

export function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
