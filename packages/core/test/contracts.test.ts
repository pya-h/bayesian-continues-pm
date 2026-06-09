// Unit tests for the contract primitives — payoff f(θ), validation, canonical
// identity keys, kinks, and boundedness. These underpin position aggregation
// (contractKey), settlement payouts (payoff), solvency (payoffKinks) and the
// trade-analytics max-payout (payoffBounds), so each is pinned directly here
// rather than only exercised indirectly through pricing/solvency.

import { describe, expect, test } from 'bun:test';
import {
  contractKey,
  payoff,
  payoffBounds,
  payoffKinks,
  validateContract,
} from '../src/contracts.ts';
import type { ContractSpec } from '../src/types.ts';

describe('payoff f(θ)', () => {
  test('LINEAR pays θ', () => {
    expect(payoff({ type: 'LINEAR' }, 42)).toBe(42);
    expect(payoff({ type: 'LINEAR' }, -7)).toBe(-7);
  });

  test('CALL = max(0, θ − K), zero at and below the strike', () => {
    const c: ContractSpec = { type: 'CALL', strike: 100 };
    expect(payoff(c, 130)).toBe(30);
    expect(payoff(c, 100)).toBe(0);
    expect(payoff(c, 80)).toBe(0);
  });

  test('PUT = max(0, K − θ), zero at and above the strike', () => {
    const p: ContractSpec = { type: 'PUT', strike: 100 };
    expect(payoff(p, 70)).toBe(30);
    expect(payoff(p, 100)).toBe(0);
    expect(payoff(p, 120)).toBe(0);
  });

  test('BINARY_CALL is 1 at the strike (θ ≥ K is inclusive)', () => {
    const b: ContractSpec = { type: 'BINARY_CALL', strike: 100 };
    expect(payoff(b, 100)).toBe(1);
    expect(payoff(b, 100.0001)).toBe(1);
    expect(payoff(b, 99.9999)).toBe(0);
  });

  test('BINARY_PUT is 1 at the strike (θ ≤ K is inclusive)', () => {
    const b: ContractSpec = { type: 'BINARY_PUT', strike: 100 };
    expect(payoff(b, 100)).toBe(1);
    expect(payoff(b, 99.9999)).toBe(1);
    expect(payoff(b, 100.0001)).toBe(0);
  });

  test('SPREAD pays 1 inside [a,b] inclusive, 0 outside', () => {
    const s: ContractSpec = { type: 'SPREAD', lower: 90, upper: 110 };
    expect(payoff(s, 100)).toBe(1);
    expect(payoff(s, 90)).toBe(1); // inclusive lower
    expect(payoff(s, 110)).toBe(1); // inclusive upper
    expect(payoff(s, 89.99)).toBe(0);
    expect(payoff(s, 110.01)).toBe(0);
  });

  test('GAUSSIAN peaks at 1 on the center and decays symmetrically', () => {
    const g: ContractSpec = { type: 'GAUSSIAN', center: 100, width: 10 };
    expect(payoff(g, 100)).toBe(1);
    expect(payoff(g, 90)).toBeCloseTo(Math.exp(-0.5), 12); // one width out
    expect(payoff(g, 110)).toBeCloseTo(payoff(g, 90), 12); // symmetry
    expect(payoff(g, 100)).toBeGreaterThan(payoff(g, 130));
  });

  test('missing/non-finite params throw', () => {
    expect(() => payoff({ type: 'CALL' } as ContractSpec, 10)).toThrow(/strike/);
    expect(() => payoff({ type: 'GAUSSIAN', center: 1 } as ContractSpec, 10)).toThrow(/width/);
  });
});

describe('validateContract', () => {
  test('accepts well-formed specs and returns them for chaining', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 100 };
    expect(validateContract(spec)).toBe(spec);
    expect(validateContract({ type: 'LINEAR' })).toEqual({ type: 'LINEAR' });
  });

  test('SPREAD requires lower < upper', () => {
    expect(() => validateContract({ type: 'SPREAD', lower: 110, upper: 90 })).toThrow(/lower/);
    expect(() => validateContract({ type: 'SPREAD', lower: 100, upper: 100 })).toThrow(/lower/);
  });

  test('GAUSSIAN requires width > 0', () => {
    expect(() => validateContract({ type: 'GAUSSIAN', center: 100, width: 0 })).toThrow(/width/);
    expect(() => validateContract({ type: 'GAUSSIAN', center: 100, width: -5 })).toThrow(/width/);
  });

  test('strike-based types require a finite strike', () => {
    expect(() => validateContract({ type: 'BINARY_CALL' } as ContractSpec)).toThrow(/strike/);
  });
});

describe('contractKey — canonical identity', () => {
  test('same economic spec → identical key (so positions aggregate)', () => {
    const a = contractKey({ type: 'CALL', strike: 100 });
    const b = contractKey({ type: 'CALL', strike: 100 });
    expect(a).toBe(b);
  });

  test('float noise below 12 sig-figs collapses to the same key', () => {
    const a = contractKey({ type: 'CALL', strike: 100 });
    const b = contractKey({ type: 'CALL', strike: 100 + 1e-13 });
    expect(a).toBe(b);
  });

  test('different strike, type, or bounds → different keys', () => {
    expect(contractKey({ type: 'CALL', strike: 100 })).not.toBe(
      contractKey({ type: 'CALL', strike: 101 }),
    );
    expect(contractKey({ type: 'CALL', strike: 100 })).not.toBe(
      contractKey({ type: 'PUT', strike: 100 }),
    );
    expect(contractKey({ type: 'SPREAD', lower: 90, upper: 110 })).not.toBe(
      contractKey({ type: 'SPREAD', lower: 90, upper: 120 }),
    );
  });

  test('all LINEAR contracts share one key', () => {
    expect(contractKey({ type: 'LINEAR' })).toBe('LINEAR');
  });
});

describe('payoffKinks', () => {
  test('vanilla/binary kink at the strike', () => {
    expect(payoffKinks({ type: 'CALL', strike: 100 })).toEqual([100]);
    expect(payoffKinks({ type: 'BINARY_PUT', strike: 50 })).toEqual([50]);
  });
  test('SPREAD kinks at both edges; GAUSSIAN peaks at center; LINEAR has none', () => {
    expect(payoffKinks({ type: 'SPREAD', lower: 90, upper: 110 })).toEqual([90, 110]);
    expect(payoffKinks({ type: 'GAUSSIAN', center: 100, width: 5 })).toEqual([100]);
    expect(payoffKinks({ type: 'LINEAR' })).toEqual([]);
  });
});

describe('payoffBounds', () => {
  test('binary/spread/gaussian are bounded to [0,1]', () => {
    for (const spec of [
      { type: 'BINARY_CALL', strike: 100 },
      { type: 'BINARY_PUT', strike: 100 },
      { type: 'SPREAD', lower: 90, upper: 110 },
      { type: 'GAUSSIAN', center: 100, width: 5 },
    ] as ContractSpec[]) {
      expect(payoffBounds(spec)).toEqual({ bounded: true, min: 0, max: 1 });
    }
  });
  test('linear/call/put are unbounded', () => {
    expect(payoffBounds({ type: 'CALL', strike: 100 }).bounded).toBe(false);
    expect(payoffBounds({ type: 'PUT', strike: 100 }).bounded).toBe(false);
    expect(payoffBounds({ type: 'LINEAR' }).bounded).toBe(false);
  });
});
