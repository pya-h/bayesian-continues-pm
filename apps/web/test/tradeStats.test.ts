import { describe, expect, test } from 'bun:test';
import { MixtureBelief, StudentTBelief } from '@bmm/core';
import { payoffRange, sellCloseStats, tradeStats } from '../src/lib/tradeStats.ts';
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

describe('sellCloseStats — closing a long', () => {
  test('selling the whole holding at a gain', () => {
    // bought 10 @ 0.4 (cost 4), sell all 10 for proceeds 7 → profit 3, +75%.
    const c = sellCloseStats({ proceeds: 7, qty: 10, heldQty: 10, avgEntryPrice: 0.4 });
    expect(c.qClosed).toBe(10);
    expect(close(c.costBasis, 4)).toBe(true);
    expect(close(c.realizedProfit, 3)).toBe(true);
    expect(close(c.returnPct ?? 0, 0.75)).toBe(true);
  });
  test('partial close only counts the closed portion of proceeds and cost', () => {
    // hold 10 @ 0.5, sell 4 for total proceeds 2.4 → closes 4, cost 2, profit 0.4.
    const c = sellCloseStats({ proceeds: 2.4, qty: 4, heldQty: 10, avgEntryPrice: 0.5 });
    expect(c.qClosed).toBe(4);
    expect(close(c.costBasis, 2)).toBe(true);
    expect(close(c.realizedProfit, 0.4)).toBe(true);
  });
  test('selling more than held only closes the holding', () => {
    // hold 4 @ 0.5, sell 10 for proceeds 6 → closes 4, proceeds for closed = 6·4/10 = 2.4.
    const c = sellCloseStats({ proceeds: 6, qty: 10, heldQty: 4, avgEntryPrice: 0.5 });
    expect(c.qClosed).toBe(4);
    expect(close(c.proceeds, 2.4)).toBe(true);
    expect(close(c.costBasis, 2)).toBe(true);
    expect(close(c.realizedProfit, 0.4)).toBe(true);
  });
  test('no holding → nothing closes, returnPct null', () => {
    const c = sellCloseStats({ proceeds: 5, qty: 10, heldQty: 0, avgEntryPrice: 0 });
    expect(c.qClosed).toBe(0);
    expect(c.realizedProfit).toBe(0);
    expect(c.returnPct).toBeNull();
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

describe('tradeStats — belief-aware win chance (REVIEW-FINDINGS C2)', () => {
  // Bimodal mixture: modes at 80 and 120, nearly no mass near 100. A long binary
  // call at K=100 wins on the upper mode only → true win chance ≈ upper weight.
  const spec: ContractSpec = { type: 'BINARY_CALL', strike: 100 };
  const mix = new MixtureBelief([
    { pi: 0.7, mu: 80, sigma2: 9 },
    { pi: 0.3, mu: 120, sigma2: 9 },
  ]);
  const args = {
    spec,
    signedQ: 10,
    totalCost: 3, // exec 0.30/unit, the mixture fair P(θ>100) = 0.3
    fair: 0.3,
    mu: mix.mean(), // 92
    sigma: mix.stddev(),
  };

  test('with the real belief, pProfit is the upper-mode mass (≈0.30)', () => {
    const s = tradeStats({ ...args, belief: mix });
    expect(close(s.pProfit, 0.3, 0.01)).toBe(true);
  });

  test('the Gaussian fallback gets it visibly wrong on the same μ/σ', () => {
    const s = tradeStats(args); // no belief → same-moments Gaussian
    // N(92, 18.5²): P(θ>100) ≈ 0.33; profit needs payoff 1 (θ>100) for a long
    // at 0.30 — the Gaussian smears mass into the dead zone between the modes
    // so it must differ from the exact 0.30 by a real margin.
    expect(Math.abs(s.pProfit - 0.3)).toBeGreaterThan(0.02);
  });

  test('fat Student-t tails are not clipped at the 10σ scan window', () => {
    const t = StudentTBelief.fromVariance(2.5, 100, 400);
    // Long CALL K=100 at cost 2/unit: profit needs θ > 102. Exact: 1 − cdf(102).
    const s = tradeStats({
      spec: { type: 'CALL', strike: 100 },
      signedQ: 1,
      totalCost: 2,
      fair: 6,
      mu: 100,
      sigma: 20,
      belief: t,
    });
    expect(close(s.pProfit, 1 - t.cdf(102), 1e-3)).toBe(true);
  });
});
