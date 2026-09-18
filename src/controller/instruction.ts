/**
 * Steering instruction contract: typed, bounded, versioned.
 *
 * The controller may only move the fast policy inside these bounds. Anything outside the
 * contract is rejected by the engine and the previously accepted instruction stays in force.
 */
export const INSTRUCTION_SCHEMA_VERSION = 1 as const;

export type QuoteSides = 'both' | 'bid_only' | 'ask_only' | 'none';

export interface SteeringParams {
  /** Multiplier on the policy's base half-spread, in thousandths (1000 = 1.0x). */
  spreadMultiplierMilli: number;
  /** Multiplier on the policy's base quote size, in thousandths (0 = do not quote). */
  sizeMultiplierMilli: number;
  /** Fraction of the risk gate's max position the policy may use, in thousandths. */
  maxInventoryFractionMilli: number;
  /** Quote skew per unit of inventory utilisation, in basis points. */
  inventorySkewBps: number;
  quoteSides: QuoteSides;
}

export interface SteeringInstruction {
  schemaVersion: typeof INSTRUCTION_SCHEMA_VERSION;
  /** Monotonic per run; the engine expects exactly prior + 1. */
  version: number;
  controllerId: string;
  /** Index of the window the controller reviewed to produce this instruction. */
  basedOnWindow: number;
  /** Simulated time at which the controller was invoked. */
  issuedAt: number;
  /** Start of the window this instruction targets. Must be the next window boundary. */
  effectiveFrom: number;
  params: SteeringParams;
  reason: string;
}

export const INSTRUCTION_BOUNDS = {
  spreadMultiplierMilli: { min: 500, max: 4000 },
  sizeMultiplierMilli: { min: 0, max: 1500 },
  maxInventoryFractionMilli: { min: 0, max: 1000 },
  inventorySkewBps: { min: 0, max: 100 },
  reasonMaxLength: 240,
  quoteSides: ['both', 'bid_only', 'ask_only', 'none'] as const,
} as const;

export type InstructionBounds = typeof INSTRUCTION_BOUNDS;

export const DEFAULT_PARAMS: Readonly<SteeringParams> = Object.freeze({
  spreadMultiplierMilli: 1000,
  sizeMultiplierMilli: 1000,
  maxInventoryFractionMilli: 1000,
  inventorySkewBps: 20,
  quoteSides: 'both',
});

/** Version 0: the safe default in force until the first accepted controller instruction. */
export function initialInstruction(startTime: number): SteeringInstruction {
  return {
    schemaVersion: INSTRUCTION_SCHEMA_VERSION,
    version: 0,
    controllerId: 'default',
    basedOnWindow: -1,
    issuedAt: startTime,
    effectiveFrom: startTime,
    params: { ...DEFAULT_PARAMS },
    reason: 'initial safe default (no controller input yet)',
  };
}

export interface InstructionExpectation {
  version: number;
  effectiveFrom: number;
  basedOnWindow: number;
}

export type InstructionValidation = { ok: true; instruction: SteeringInstruction } | { ok: false; errors: string[] };

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Validate an untrusted candidate against the contract and the engine's expectation. */
export function validateInstruction(candidate: unknown, expect: InstructionExpectation): InstructionValidation {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== 'object') return { ok: false, errors: ['instruction is not an object'] };
  const c = candidate as Record<string, unknown>;
  if (c['schemaVersion'] !== INSTRUCTION_SCHEMA_VERSION) errors.push(`schemaVersion must be ${INSTRUCTION_SCHEMA_VERSION}`);
  if (!isInt(c['version'])) errors.push('version must be an integer');
  else if (c['version'] !== expect.version) errors.push(`version must be ${expect.version}, got ${c['version']}`);
  if (typeof c['controllerId'] !== 'string' || c['controllerId'].length === 0) errors.push('controllerId required');
  if (!isInt(c['basedOnWindow'])) errors.push('basedOnWindow must be an integer');
  else if (c['basedOnWindow'] !== expect.basedOnWindow) {
    errors.push(`basedOnWindow must be ${expect.basedOnWindow}, got ${c['basedOnWindow']}`);
  }
  if (!isInt(c['issuedAt'])) errors.push('issuedAt must be an integer');
  if (!isInt(c['effectiveFrom'])) errors.push('effectiveFrom must be an integer');
  else if (c['effectiveFrom'] !== expect.effectiveFrom) {
    errors.push(`effectiveFrom must be ${expect.effectiveFrom}, got ${c['effectiveFrom']}`);
  }
  if (typeof c['reason'] !== 'string') errors.push('reason must be a string');
  else if (c['reason'].length > INSTRUCTION_BOUNDS.reasonMaxLength) errors.push('reason too long');

  const p = c['params'];
  if (!p || typeof p !== 'object') {
    errors.push('params missing');
  } else {
    const params = p as Record<string, unknown>;
    for (const key of ['spreadMultiplierMilli', 'sizeMultiplierMilli', 'maxInventoryFractionMilli', 'inventorySkewBps'] as const) {
      const v = params[key];
      const b = INSTRUCTION_BOUNDS[key];
      if (!isInt(v)) errors.push(`${key} must be an integer`);
      else if (v < b.min || v > b.max) errors.push(`${key}=${v} outside [${b.min}, ${b.max}]`);
    }
    if (!(INSTRUCTION_BOUNDS.quoteSides as readonly unknown[]).includes(params['quoteSides'])) {
      errors.push(`quoteSides must be one of ${INSTRUCTION_BOUNDS.quoteSides.join('|')}`);
    }
    const extra = Object.keys(params).filter(
      (k) => !['spreadMultiplierMilli', 'sizeMultiplierMilli', 'maxInventoryFractionMilli', 'inventorySkewBps', 'quoteSides'].includes(k),
    );
    if (extra.length) errors.push(`unknown params: ${extra.join(', ')}`);
  }
  if (errors.length) return { ok: false, errors };
  const params = c['params'] as SteeringParams;
  return {
    ok: true,
    instruction: {
      schemaVersion: INSTRUCTION_SCHEMA_VERSION,
      version: c['version'] as number,
      controllerId: c['controllerId'] as string,
      basedOnWindow: c['basedOnWindow'] as number,
      issuedAt: c['issuedAt'] as number,
      effectiveFrom: c['effectiveFrom'] as number,
      params: {
        spreadMultiplierMilli: params.spreadMultiplierMilli,
        sizeMultiplierMilli: params.sizeMultiplierMilli,
        maxInventoryFractionMilli: params.maxInventoryFractionMilli,
        inventorySkewBps: params.inventorySkewBps,
        quoteSides: params.quoteSides,
      },
      reason: c['reason'] as string,
    },
  };
}

/** Clamp params into bounds. Helper for controllers; the engine never clamps, it rejects. */
export function clampParams(p: SteeringParams): SteeringParams {
  const clamp = (v: number, b: { min: number; max: number }): number => Math.min(b.max, Math.max(b.min, Math.round(v)));
  return {
    spreadMultiplierMilli: clamp(p.spreadMultiplierMilli, INSTRUCTION_BOUNDS.spreadMultiplierMilli),
    sizeMultiplierMilli: clamp(p.sizeMultiplierMilli, INSTRUCTION_BOUNDS.sizeMultiplierMilli),
    maxInventoryFractionMilli: clamp(p.maxInventoryFractionMilli, INSTRUCTION_BOUNDS.maxInventoryFractionMilli),
    inventorySkewBps: clamp(p.inventorySkewBps, INSTRUCTION_BOUNDS.inventorySkewBps),
    quoteSides: (INSTRUCTION_BOUNDS.quoteSides as readonly string[]).includes(p.quoteSides) ? p.quoteSides : 'none',
  };
}
