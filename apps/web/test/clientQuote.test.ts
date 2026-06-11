import { describe, expect, test } from 'bun:test';
import { GaussianBelief, MixtureBelief, StudentTBelief, price } from '@bmm/core';
import { beliefFromView } from '../src/lib/beliefFromView.ts';
import { estimateQuote } from '../src/lib/clientQuote.ts';
import type { Belief, ContractSpec } from '../src/lib/types.ts';

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
      const q = estimateQuote({ spec, signedQ: 3, belief, spreadTotal: 0.4 });
      expect(close(q.fair, price(spec, belief))).toBe(true);
    }
  });

  test('a buy pays the ask: exec = fair + spread, totalCost > 0', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const q = estimateQuote({ spec, signedQ: 5, belief, spreadTotal: 0.5 });
    expect(close(q.execPrice, q.fair + 0.5)).toBe(true);
    expect(close(q.totalCost, q.execPrice * 5)).toBe(true);
    expect(q.totalCost).toBeGreaterThan(0);
  });

  test('a sell receives the bid: exec = fair − spread, totalCost < 0', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const q = estimateQuote({ spec, signedQ: -5, belief, spreadTotal: 0.5 });
    expect(close(q.execPrice, q.fair - 0.5)).toBe(true);
    expect(close(q.totalCost, q.execPrice * -5)).toBe(true);
    expect(q.totalCost).toBeLessThan(0);
  });

  test('the sell bid is floored at zero (never a negative price)', () => {
    // A deep-OTM binary has a tiny fair; a wide spread would push the bid below 0.
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 1000 };
    const q = estimateQuote({ spec, signedQ: -2, belief, spreadTotal: 5 });
    expect(q.execPrice).toBe(0);
    expect(q.totalCost === 0).toBe(true); // ±0: a floored bid pays/receives nothing
  });

  test('a zero spread reproduces the mid for both sides', () => {
    const spec: ContractSpec = { type: 'LINEAR' };
    const buy = estimateQuote({ spec, signedQ: 1, belief, spreadTotal: 0 });
    const sell = estimateQuote({ spec, signedQ: -1, belief, spreadTotal: 0 });
    expect(close(buy.execPrice, mu)).toBe(true);
    expect(close(sell.execPrice, mu)).toBe(true);
  });

  test('degenerate σ ≤ 0 does not throw (beliefFromView clamps to a positive variance)', () => {
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 100 };
    const degenerate = beliefFromView({ kind: 'gaussian', mu: 100, sigma: 0, sigma2: 0 });
    const q = estimateQuote({ spec, signedQ: 1, belief: degenerate, spreadTotal: 0.1 });
    expect(Number.isFinite(q.fair)).toBe(true);
    expect(close(q.fair, 0.5, 1e-6)).toBe(true); // at-the-money binary, σ→0 → Φ(0) = 0.5
  });

  test('fair prices a mixture / Student-t market against its TRUE belief, not a Gaussian', () => {
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 75 };

    // Bimodal mixture: priced as Σπ_k·price_k, which a single Gaussian of equal
    // mean/σ cannot reproduce.
    const mixView: Belief = {
      kind: 'mixture',
      mu: 70,
      sigma: 14,
      sigma2: 196,
      components: [
        { pi: 0.5, mu: 60, sigma: 5 },
        { pi: 0.5, mu: 80, sigma: 5 },
      ],
    };
    const mix = estimateQuote({
      spec,
      signedQ: 1,
      belief: beliefFromView(mixView),
      spreadTotal: 0,
    });
    expect(
      close(
        mix.fair,
        price(
          spec,
          new MixtureBelief([
            { pi: 0.5, mu: 60, sigma2: 25 },
            { pi: 0.5, mu: 80, sigma2: 25 },
          ]),
        ),
      ),
    ).toBe(true);

    // Student-t: priced with fat tails, distinct from the Gaussian of equal σ.
    const tView: Belief = { kind: 'student_t', mu: 70, sigma: 14, sigma2: 196, nu: 5 };
    const t = estimateQuote({ spec, signedQ: 1, belief: beliefFromView(tView), spreadTotal: 0 });
    const tBelief = StudentTBelief.fromVariance(5, 70, 14 * 14);
    expect(close(t.fair, price(spec, tBelief))).toBe(true);
    expect(close(t.fair, price(spec, new GaussianBelief(70, 196)))).toBe(false);
  });
});
