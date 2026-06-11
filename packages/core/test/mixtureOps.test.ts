import { describe, expect, test } from 'bun:test';
import { MixtureBelief, type MixtureComponent } from '../src/mixture.ts';
import {
  DEFAULT_MIXTURE_OPS,
  manageMixture,
  mergeComponents,
  mergeTwo,
  pruneComponents,
  splitComponent,
} from '../src/mixture_ops.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('mixture_ops — merge/prune invariants (V2-1)', () => {
  test('mergeTwo conserves combined weight, mean, and variance exactly', () => {
    const a: MixtureComponent = { pi: 0.3, mu: 10, sigma2: 4 };
    const b: MixtureComponent = { pi: 0.5, mu: 14, sigma2: 9 };
    const m = mergeTwo(a, b);
    const piT = a.pi + b.pi;
    expect(approx(m.pi, piT, 1e-12)).toBe(true);
    // pair mean / variance (renormalized within the pair)
    const meanPair = (a.pi * a.mu + b.pi * b.mu) / piT;
    const ex2 = (a.pi * (a.sigma2 + a.mu ** 2) + b.pi * (b.sigma2 + b.mu ** 2)) / piT;
    expect(approx(m.mu, meanPair, 1e-12)).toBe(true);
    expect(approx(m.sigma2, ex2 - meanPair ** 2, 1e-9)).toBe(true);
  });

  test('a merge leaves the whole mixture mean and variance unchanged', () => {
    // two near-duplicate components that should fuse
    const before = new MixtureBelief([
      { pi: 0.4, mu: 100, sigma2: 25 },
      { pi: 0.3, mu: 101, sigma2: 25 }, // |Δμ|=1 < 0.5·(5+5)=5 → merge
      { pi: 0.3, mu: 160, sigma2: 36 },
    ]);
    const after = manageMixture(before, { ...DEFAULT_MIXTURE_OPS, piMin: 0 });
    expect(after.components.length).toBe(2); // the two close ones fused
    expect(approx(after.mean(), before.mean(), 1e-9)).toBe(true);
    expect(approx(after.variance(), before.variance(), 1e-6)).toBe(true);
  });

  test('prune drops sub-threshold components and renormalizes to Σπ=1', () => {
    const comps: MixtureComponent[] = [
      { pi: 0.95, mu: 50, sigma2: 9 },
      { pi: 0.05, mu: 200, sigma2: 9 },
    ];
    const kept = pruneComponents(comps, 0.1);
    expect(kept.length).toBe(1);
    expect(
      approx(
        kept.reduce((s, c) => s + c.pi, 0),
        1,
        1e-12,
      ),
    ).toBe(true);
  });

  test('prune perturbs the mean only by O(π_pruned)', () => {
    const before = new MixtureBelief([
      { pi: 0.97, mu: 50, sigma2: 9 },
      { pi: 0.03, mu: 250, sigma2: 9 },
    ]);
    const after = manageMixture(before, { piMin: 0.05, tauMerge: 0, maxComponents: 10 });
    expect(after.components.length).toBe(1);
    // dropped 3% of mass sitting 200 away → mean shifts by at most 0.03·200 = 6
    expect(Math.abs(after.mean() - before.mean()) <= 6 + 1e-9).toBe(true);
  });

  test('never empties out: all-below-floor keeps the single heaviest', () => {
    const kept = pruneComponents(
      [
        { pi: 0.01, mu: 1, sigma2: 1 },
        { pi: 0.02, mu: 2, sigma2: 1 },
      ],
      0.5,
    );
    expect(kept.length).toBe(1);
    expect(approx(kept[0]?.mu ?? 0, 2, 1e-12)).toBe(true); // the heavier one
    expect(approx(kept[0]?.pi ?? 0, 1, 1e-12)).toBe(true);
  });

  test('maxComponents cap force-merges the closest pairs', () => {
    const comps: MixtureComponent[] = [
      { pi: 0.2, mu: 0, sigma2: 1 },
      { pi: 0.2, mu: 50, sigma2: 1 },
      { pi: 0.2, mu: 100, sigma2: 1 },
      { pi: 0.2, mu: 150, sigma2: 1 },
      { pi: 0.2, mu: 200, sigma2: 1 }, // all far apart: τ-merge won't fire
    ];
    const out = mergeComponents(comps, { piMin: 0, tauMerge: 0.001, maxComponents: 3 });
    expect(out.length).toBe(3);
    expect(
      approx(
        out.reduce((s, c) => s + c.pi, 0),
        1,
        1e-9,
      ),
    ).toBe(true);
  });

  test('distinct, within-cap modes are left untouched', () => {
    const before = new MixtureBelief([
      { pi: 0.5, mu: 0, sigma2: 1 },
      { pi: 0.5, mu: 100, sigma2: 1 },
    ]);
    const after = manageMixture(before, DEFAULT_MIXTURE_OPS);
    expect(after.components.length).toBe(2);
  });

  test('splitComponent halves weight and straddles the mean', () => {
    const [lo, hi] = splitComponent({ pi: 0.6, mu: 100, sigma2: 16 });
    expect(approx(lo.pi + hi.pi, 0.6, 1e-12)).toBe(true);
    expect(lo.mu < 100 && hi.mu > 100).toBe(true);
    expect(approx((lo.mu + hi.mu) / 2, 100, 1e-9)).toBe(true);
  });
});
