import { describe, expect, test } from 'bun:test';
import { bayesUpdateMixture, updateBelief } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { MixtureBelief } from '../src/mixture.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const cfg = makeEngineConfig(70, 10, {});

function heaviestNear(belief: MixtureBelief, target: number) {
  // weight mass within ±15 of target
  let w = 0;
  for (const c of belief.components) if (Math.abs(c.mu - target) < 15) w += c.pi;
  return w;
}

describe('bayesUpdateMixture (V2-1)', () => {
  const bimodal = () =>
    new MixtureBelief([
      { pi: 0.5, mu: 60, sigma2: 25 },
      { pi: 0.5, mu: 80, sigma2: 25 },
    ]);

  test('weight=0 leaves the shape unchanged', () => {
    const before = bimodal();
    const after = bayesUpdateMixture(before, 75, 0, cfg);
    expect(after.components.length).toBe(2);
    expect(approx(after.mean(), before.mean(), 1e-9)).toBe(true);
  });

  test('a signal at one mode concentrates weight on that mode', () => {
    let belief = bimodal();
    const before = heaviestNear(belief, 80);
    // stream of consistent bullish signals near 80
    for (let i = 0; i < 8; i++) belief = bayesUpdateMixture(belief, 81, 0.8, cfg);
    const after = heaviestNear(belief, 80);
    expect(after > before).toBe(true);
    expect(after > 0.7).toBe(true); // upper camp dominates
  });

  test('both modes persist under disagreement (does not collapse to one bump)', () => {
    let belief = bimodal();
    // alternate bullish (near 80) and bearish (near 60) signals
    for (let i = 0; i < 10; i++) {
      belief = bayesUpdateMixture(belief, i % 2 === 0 ? 80 : 60, 0.6, cfg);
    }
    // still two distinct camps, mean stuck in the disputed middle
    expect(belief.components.length >= 2).toBe(true);
    expect(approx(belief.mean(), 70, 8)).toBe(true);
    expect(heaviestNear(belief, 60) > 0.2).toBe(true);
    expect(heaviestNear(belief, 80) > 0.2).toBe(true);
  });

  test('the owning component absorbs the signal; the far one barely moves', () => {
    const before = bimodal();
    const after = bayesUpdateMixture(before, 80, 1, cfg);
    // find components nearest each original mode
    const near80 = after.components.reduce((a, b) =>
      Math.abs(b.mu - 80) < Math.abs(a.mu - 80) ? b : a,
    );
    const near60 = after.components.reduce((a, b) =>
      Math.abs(b.mu - 60) < Math.abs(a.mu - 60) ? b : a,
    );
    expect(Math.abs(near60.mu - 60) < 3).toBe(true); // bearish camp held its ground
    expect(near80.pi > 0.5).toBe(true); // bullish camp gained membership
  });

  test('updateBelief dispatches mixtures to the mixture path', () => {
    const out = updateBelief(bimodal(), 80, 0.5, cfg);
    expect(out.kind).toBe('mixture');
  });
});
