// adaptive (mode-spawning) mixture update for Gen·basis.
// Spawning is gated on `opsCfg.allowSpawn` (off for the legacy `mixture` kind).
// A confident signal far from every mode seeds a new component; the responsibility
// step then grows a mode there, and `manageMixture` merges it back if redundant.

import { describe, expect, test } from 'bun:test';
import { bayesUpdateMixture } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { DEFAULT_MIXTURE_OPS, type MixtureOpsConfig } from '../src/mixture_ops.ts';

const cfg = makeEngineConfig(70, 10, {}); // σ_ε = σ_min·… = 10, σ_min = 1
const spawnOps: MixtureOpsConfig = {
  ...DEFAULT_MIXTURE_OPS,
  allowSpawn: true,
  maxComponents: 6,
  tauSpawn: 3,
};

const single = () => new MixtureBelief([{ pi: 1, mu: 70, sigma2: 25 }]);
const sumPi = (b: MixtureBelief) => b.components.reduce((s, c) => s + c.pi, 0);
const hasModeNear = (b: MixtureBelief, x: number, tol = 6) =>
  b.components.some((c) => Math.abs(c.mu - x) < tol);

function gridMoments(b: MixtureBelief, lo: number, hi: number, n = 20000) {
  const h = (hi - lo) / n;
  let mass = 0;
  let mean = 0;
  for (let i = 0; i <= n; i++) {
    const x = lo + i * h;
    const w = i === 0 || i === n ? 0.5 : 1; // trapezoid
    const p = b.pdf(x);
    mass += w * p;
    mean += w * x * p;
  }
  return { mass: mass * h, mean: (mean * h) / (mass * h) };
}

describe('adaptive spawning — gated behavior', () => {
  test('allowSpawn gates spawning; the off-path is byte-identical to the default', () => {
    const far = 110; // far enough that Gen·basis spawns, near enough the old mode survives
    const offDefault = bayesUpdateMixture(single(), far, 0.9, cfg); // default ops: spawn off
    const offExplicit = bayesUpdateMixture(single(), far, 0.9, cfg, {
      ...DEFAULT_MIXTURE_OPS,
      allowSpawn: false,
    });
    const on = bayesUpdateMixture(single(), far, 0.9, cfg, spawnOps);
    expect(offDefault.components.length).toBe(1); // no spawn when off — consensus just slides
    expect(offExplicit.components.length).toBe(1);
    expect(offExplicit.components.map((c) => [c.pi, c.mu, c.sigma2])).toEqual(
      offDefault.components.map((c) => [c.pi, c.mu, c.sigma2]),
    );
    expect(on.components.length).toBe(2); // Gen·basis seeds the far mode
  });

  test('a low-weight far signal does not spawn (needs spawnWeightMin)', () => {
    const after = bayesUpdateMixture(single(), 130, 0.02, cfg, spawnOps); // weight < 0.1
    expect(after.components.length).toBe(1);
  });

  test('nearby confident bets never spawn (stay within τ_spawn·σ)', () => {
    let b = single();
    for (let i = 0; i < 8; i++) b = bayesUpdateMixture(b, 72, 0.8, cfg, spawnOps); // ~0.4σ away
    expect(b.components.length).toBe(1);
  });
});

describe('adaptive spawning — grows + holds a new mode', () => {
  test('disagreement (consensus vs a far camp) grows a second mode from one', () => {
    let b = single();
    expect(b.components.length).toBe(1);
    // alternate consensus (70) and a far dissenting camp (110)
    for (let i = 0; i < 16; i++)
      b = bayesUpdateMixture(b, i % 2 === 0 ? 70 : 110, 0.8, cfg, spawnOps);
    expect(b.components.length).toBeGreaterThanOrEqual(2);
    expect(hasModeNear(b, 70)).toBe(true); // consensus camp held
    // the dissenting camp persists as a distinct mode well above consensus (it
    // equilibrates a touch below the 110 signal — strong prior precision anchors it)
    expect(b.components.some((c) => c.mu > 90)).toBe(true);
  });

  test('mass stays normalized and moments stay consistent at every step', () => {
    let b = single();
    const signals = [70, 110, 70, 110, 40, 110, 70, 40, 110, 70];
    for (const s of signals) {
      b = bayesUpdateMixture(b, s, 0.8, cfg, spawnOps);
      expect(Math.abs(sumPi(b) - 1)).toBeLessThan(1e-9);
      const g = gridMoments(b, -100, 300);
      expect(Math.abs(g.mass - 1)).toBeLessThan(1e-3); // density integrates to 1
      expect(Math.abs(g.mean - b.mean())).toBeLessThan(0.5); // grid mean ≈ class mean
    }
  });
});

describe('adaptive spawning — stays bounded', () => {
  test('component count never exceeds maxComponents under a chaotic far stream', () => {
    const ops: MixtureOpsConfig = { ...spawnOps, maxComponents: 4 };
    let b = single();
    let maxSeen = 1;
    // cycle through many distinct far locations
    const locs = [70, 110, 150, 30, 190, 70, 230, 110, 150, 30, 190, 230, 70, 150];
    for (const s of locs) {
      b = bayesUpdateMixture(b, s, 0.8, cfg, ops);
      maxSeen = Math.max(maxSeen, b.components.length);
      expect(b.components.length).toBeLessThanOrEqual(4);
      expect(Math.abs(sumPi(b) - 1)).toBeLessThan(1e-9);
    }
    expect(maxSeen).toBeGreaterThanOrEqual(2); // it did grow beyond the initial single mode
  });
});
