import { describe, expect, test } from 'bun:test';
import { GaussianBelief, price } from '@bmm/core';
import { estimateQuote } from '../src/lib/clientQuote.ts';
import type { ContractSpec } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('estimateQuote', () => {
  const mu = 100;
  const sigma = 12;
  const belief = new GaussianBelief(mu, sigma * sigma);

  test('fair equals the core closed-form price for the spec', () => {
    const specs: ContractSpec[] = [
      { type: 'LINEAR' },
      { type: 'CALL', strike: 110 },
      { type: 'BINARY_CALL', strike: 95 },
      { type: 'SPREAD', lower: 90, upper: 115 },
      { type: 'GAUSSIAN', center: 100, width: 8 },
    ];
    for (const spec of specs) {
      const q = estimateQuote({ spec, signedQ: 3, mu, sigma, spreadTotal: 0.4 });
      expect(close(q.fair, price(spec, belief))).toBe(true);
    }
  });

  test('a buy pays the ask: exec = fair + spread, totalCost > 0', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const q = estimateQuote({ spec, signedQ: 5, mu, sigma, spreadTotal: 0.5 });
    expect(close(q.execPrice, q.fair + 0.5)).toBe(true);
    expect(close(q.totalCost, q.execPrice * 5)).toBe(true);
    expect(q.totalCost).toBeGreaterThan(0);
  });

  test('a sell receives the bid: exec = fair − spread, totalCost < 0', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const q = estimateQuote({ spec, signedQ: -5, mu, sigma, spreadTotal: 0.5 });
    expect(close(q.execPrice, q.fair - 0.5)).toBe(true);
    expect(close(q.totalCost, q.execPrice * -5)).toBe(true);
    expect(q.totalCost).toBeLessThan(0);
  });

  test('the sell bid is floored at zero (never a negative price)', () => {
    // A deep-OTM binary has a tiny fair; a wide spread would push the bid below 0.
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 1000 };
    const q = estimateQuote({ spec, signedQ: -2, mu, sigma, spreadTotal: 5 });
    expect(q.execPrice).toBe(0);
    expect(q.totalCost === 0).toBe(true); // ±0: a floored bid pays/receives nothing
  });

  test('a zero spread reproduces the mid for both sides', () => {
    const spec: ContractSpec = { type: 'LINEAR' };
    const buy = estimateQuote({ spec, signedQ: 1, mu, sigma, spreadTotal: 0 });
    const sell = estimateQuote({ spec, signedQ: -1, mu, sigma, spreadTotal: 0 });
    expect(close(buy.execPrice, mu)).toBe(true);
    expect(close(sell.execPrice, mu)).toBe(true);
  });

  test('degenerate σ ≤ 0 does not throw (clamped to a positive variance)', () => {
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 100 };
    const q = estimateQuote({ spec, signedQ: 1, mu: 100, sigma: 0, spreadTotal: 0.1 });
    expect(Number.isFinite(q.fair)).toBe(true);
    expect(close(q.fair, 0.5, 1e-6)).toBe(true); // at-the-money binary, σ→0 → Φ(0) = 0.5
  });
});
