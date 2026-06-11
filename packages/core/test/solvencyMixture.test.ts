import { describe, expect, test } from 'bun:test';
import { GaussianBelief } from '../src/gaussian.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { type BookEntry, expectedLiability, requiredReserve } from '../src/solvency.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('solvency under a mixture belief (V2-1)', () => {
  // MM is short a binary call (owes 1 if θ > strike) → real tail exposure.
  const book: BookEntry[] = [{ spec: { type: 'BINARY_CALL', strike: 75000 }, mmShort: 1000 }];

  const mix = new MixtureBelief([
    { pi: 0.5, mu: 60000, sigma2: 4000 ** 2 },
    { pi: 0.5, mu: 80000, sigma2: 4000 ** 2 },
  ]);

  test('requiredReserve is deterministic (seeded) and positive for real exposure', () => {
    const r1 = requiredReserve(book, mix);
    const r2 = requiredReserve(book, mix);
    expect(r1).toBe(r2); // seeded MC → reproducible
    expect(r1 > 0).toBe(true);
    expect(r1 <= 1000).toBe(true); // can't owe more than mmShort·max payoff
  });

  test('a bimodal belief needs more reserve than a tight Gaussian at the same mean', () => {
    // tight unimodal belief at the mixture mean (70000): the strike at 75000 is
    // comfortably above, so binary-call exposure is small...
    const tight = new GaussianBelief(70000, 2000 ** 2);
    const rTight = requiredReserve(book, tight);
    // ...but the bimodal belief puts a whole camp at 80000 (above the strike)
    // so the 99% tail liability is much larger.
    const rMix = requiredReserve(book, mix);
    expect(rMix > rTight).toBe(true);
  });

  test('expectedLiability = mmShort · mixture price', () => {
    const el = expectedLiability(book, mix);
    // mixture price of the binary call, times mmShort
    const expected = 1000 * 0.5; // each camp: ~Φ(±)... use loose check via direct calc
    // 60000 camp: Φ((60000-75000)/4000)=Φ(-3.75)≈0; 80000 camp: Φ((80000-75000)/4000)=Φ(1.25)≈0.894
    const approxPrice = 0.5 * 0 + 0.5 * 0.8944;
    expect(approx(el, 1000 * approxPrice, 5)).toBe(true);
    void expected;
  });
});
