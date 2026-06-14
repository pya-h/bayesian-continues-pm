import { describe, expect, test } from 'bun:test';
import { beliefFromView } from '../src/lib/beliefFromView.ts';
import type { Belief } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('beliefFromView', () => {
  test('gaussian → GaussianBelief with matching mean/variance', () => {
    const b = beliefFromView({ kind: 'gaussian', mu: 100, sigma: 12, sigma2: 144 });
    expect(b.kind).toBe('gaussian');
    expect(close(b.mean(), 100)).toBe(true);
    expect(close(b.variance(), 144)).toBe(true);
  });

  test('mixture → MixtureBelief whose moments match the components (law of total variance)', () => {
    const view: Belief = {
      kind: 'mixture',
      mu: 70,
      sigma: 14,
      sigma2: 196,
      components: [
        { pi: 0.5, mu: 60, sigma: 5 },
        { pi: 0.5, mu: 80, sigma: 5 },
      ],
    };
    const b = beliefFromView(view);
    expect(b.kind).toBe('mixture');
    expect(close(b.mean(), 70)).toBe(true);
    // Var = within (25) + between (0.5·100 + 0.5·100) = 25 + 100 = 125.
    expect(close(b.variance(), 125)).toBe(true);
  });

  test('student_t → StudentTBelief with ν preserved and stddev = the summary σ', () => {
    const view: Belief = { kind: 'student_t', mu: 70, sigma: 14, sigma2: 196, nu: 5 };
    const b = beliefFromView(view);
    expect(b.kind).toBe('student_t');
    expect(close(b.mean(), 70)).toBe(true);
    expect(close(b.stddev(), 14, 1e-6)).toBe(true);
    expect((b as unknown as { nu: number }).nu).toBe(5);
  });

  test('gen_exact → GenExactBelief reconstructed from loc/scale + λ (not the summary)', () => {
    const view: Belief = {
      kind: 'gen_exact',
      mu: 71.5, // summary mean (skew-shifted) — NOT what reconstructs the belief
      sigma: 10.4,
      sigma2: 108,
      lambdas: [1, 0.3, 0.1],
      loc: 70,
      scale: 10,
    };
    const b = beliefFromView(view);
    expect(b.kind).toBe('gen_exact');
    expect((b as unknown as { mu: number }).mu).toBe(70); // raw location, not the summary mean
    expect((b as unknown as { sigma: number }).sigma).toBe(10);
    expect((b as unknown as { lambdas: number[] }).lambdas).toEqual([1, 0.3, 0.1]);
  });

  test('gen_exact without loc/scale falls back to the Gaussian summary', () => {
    const b = beliefFromView({
      kind: 'gen_exact',
      mu: 5,
      sigma: 2,
      sigma2: 4,
      lambdas: [1, 0, 0],
    } as Belief);
    expect(b.kind).toBe('gaussian');
  });

  test('degenerate inputs fall back to the Gaussian summary', () => {
    // mixture with no components
    const noComp = beliefFromView({ kind: 'mixture', mu: 5, sigma: 2, sigma2: 4 } as Belief);
    expect(noComp.kind).toBe('gaussian');
    // student_t with ν ≤ 2 (infinite variance) → Gaussian summary
    const lowNu = beliefFromView({ kind: 'student_t', mu: 5, sigma: 2, sigma2: 4, nu: 2 });
    expect(lowNu.kind).toBe('gaussian');
    // σ ≤ 0 is clamped to a positive variance (never throws)
    const flat = beliefFromView({ kind: 'gaussian', mu: 5, sigma: 0, sigma2: 0 });
    expect(flat.kind).toBe('gaussian');
    expect(flat.variance()).toBeGreaterThan(0);
  });
});
