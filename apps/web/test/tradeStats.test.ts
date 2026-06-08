import { describe, expect, test } from 'bun:test';
import { payoffRange, tradeStats } from '../src/lib/tradeStats.ts';
import type { ContractSpec } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('payoffRange', () => {
  test('bounded contracts are [0, 1]', () => {
    expect(payoffRange({ type: 'BINARY_CALL', strike: 100 })).toEqual({ min: 0, max: 1 });
    expect(payoffRange({ type: 'SPREAD', lower: 40, upper: 60 })).toEqual({ min: 0, max: 1 });
    expect(payoffRange({ type: 'GAUSSIAN', center: 50, width: 8 })).toEqual({ min: 0, max: 1 });
  });
  test('a CALL is unbounded above, floored at 0', () => {
    const r = payoffRange({ type: 'CALL', strike: 100 });
    expect(r.min).toBe(0);
    expect(r.max).toBe(Number.POSITIVE_INFINITY);
  });
  test('outcome bounds make a CALL finite', () => {
    // max payoff at θ = outcomeMax = 200 → 200 − 100 = 100.
    const r = payoffRange({ type: 'CALL', strike: 100 }, 0, 200);
    expect(r.min).toBe(0);
    expect(close(r.max, 100)).toBe(true);
  });
  test('LINEAR tracks the outcome bounds', () => {
    expect(payoffRange({ type: 'LINEAR' }, -10, 50)).toEqual({ min: -10, max: 50 });
  });
});

describe('tradeStats — long binary call', () => {
  const spec: ContractSpec = { type: 'BINARY_CALL', strike: 100 };
  const s = tradeStats({
    spec,
    signedQ: 10,
    totalCost: 4, // paid
    fair: 0.4,
    mu: 100,
    sigma: 10,
  });
  test('max payout / profit / loss', () => {
    expect(close(s.contractMaxPayout, 10)).toBe(true); // 10 × payoff-max(1)
    expect(close(s.maxProfit, 6)).toBe(true); // 10 − 4
    expect(close(s.maxLoss, 4)).toBe(true); // lose the 4 paid
  });
  test('expected P&L and risk:reward', () => {
    expect(close(s.expectedPnl, 0)).toBe(true); // 10·0.4 − 4
    expect(close(s.riskReward ?? 0, 1.5, 1e-9)).toBe(true); // 6 / 4
  });
  test('win chance ≈ P(θ ≥ 100) = 0.5 and breakeven ≈ strike', () => {
    expect(close(s.pProfit, 0.5, 0.02)).toBe(true);
    expect(s.breakevens.length).toBeGreaterThanOrEqual(1);
    expect(close(s.breakevens[0] ?? 0, 100, 1)).toBe(true);
  });
});

describe('tradeStats — long call has unbounded upside but capped loss', () => {
  const s = tradeStats({
    spec: { type: 'CALL', strike: 100 },
    signedQ: 10,
    totalCost: 30,
    fair: 3,
    mu: 100,
    sigma: 12,
  });
  test('upside is ∞, loss is the premium, no finite risk:reward', () => {
    expect(s.contractMaxPayout).toBe(Number.POSITIVE_INFINITY);
    expect(s.maxProfit).toBe(Number.POSITIVE_INFINITY);
    expect(close(s.maxLoss, 30)).toBe(true);
    expect(s.riskReward).toBeNull();
  });
  test('breakeven solves 10·(θ−100) = 30 → θ = 103', () => {
    expect(close(s.breakevens[0] ?? 0, 103, 0.2)).toBe(true);
  });
});

describe('tradeStats — short binary call (premium received)', () => {
  const s = tradeStats({
    spec: { type: 'BINARY_CALL', strike: 100 },
    signedQ: -10,
    totalCost: -4, // received
    fair: 0.4,
    mu: 100,
    sigma: 10,
  });
  test('keeps the premium at best, owes the payout at worst', () => {
    expect(close(s.maxProfit, 4)).toBe(true); // premium kept
    expect(close(s.maxLoss, 6)).toBe(true); // 10·1 − 4
  });
  test('win chance is the complement of the long ≈ 0.5', () => {
    expect(close(s.pProfit, 0.5, 0.02)).toBe(true);
  });
});
