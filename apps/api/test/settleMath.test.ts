// unit tests — pure settlement math (no DB). Covers position payout per
// contract type and cost-basis refund.

import { describe, expect, test } from 'bun:test';
import { positionPayout, positionRefund } from '../src/services/settleMath.ts';

describe('positionPayout = quantity · f(θ*)', () => {
  test('LINEAR pays quantity · θ', () => {
    expect(positionPayout({ type: 'LINEAR' }, 3, 50)).toBe(150);
  });

  test('CALL pays max(0, θ−K) per unit', () => {
    expect(positionPayout({ type: 'CALL', strike: 100 }, 10, 130)).toBe(300);
    expect(positionPayout({ type: 'CALL', strike: 100 }, 10, 90)).toBe(0); // OTM
  });

  test('PUT pays max(0, K−θ) per unit', () => {
    expect(positionPayout({ type: 'PUT', strike: 100 }, 2, 80)).toBe(40);
    expect(positionPayout({ type: 'PUT', strike: 100 }, 2, 120)).toBe(0); // OTM
  });

  test('BINARY_CALL pays 1 per unit when θ ≥ K (inclusive), else 0', () => {
    expect(positionPayout({ type: 'BINARY_CALL', strike: 100 }, 5, 100)).toBe(5);
    expect(positionPayout({ type: 'BINARY_CALL', strike: 100 }, 5, 99.9)).toBe(0);
  });

  test('SPREAD pays 1 per unit inside [a,b]', () => {
    const spec = { type: 'SPREAD' as const, lower: 90, upper: 110 };
    expect(positionPayout(spec, 7, 100)).toBe(7);
    expect(positionPayout(spec, 7, 120)).toBe(0);
  });

  test('GAUSSIAN peaks at the center', () => {
    expect(positionPayout({ type: 'GAUSSIAN', center: 100, width: 10 }, 4, 100)).toBe(4);
    expect(positionPayout({ type: 'GAUSSIAN', center: 100, width: 10 }, 4, 200)).toBeCloseTo(0, 6);
  });
});

describe('positionRefund = quantity · avgEntryPrice', () => {
  test('refunds the cost basis still locked in the holding', () => {
    expect(positionRefund(10, 5.5)).toBe(55);
  });

  test('a closed position (quantity 0) refunds nothing', () => {
    expect(positionRefund(0, 7.25)).toBe(0);
  });
});
