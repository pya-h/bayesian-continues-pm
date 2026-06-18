// G6 — legacy-stability golden-master. The multi-model refactor (Gen·basis
// Gen·exact, the G5 contract extensions, the `model` tag) must leave the three
// classic belief models — gaussian / mixture / student_t — pricing and updating
// **byte-for-byte unchanged**. These frozen reference values were captured from the
// pre-refactor engine; any silent drift in the legacy math trips this test.
// (Under the pre-launch / droppable-old-data stance there is no persisted
// pre-refactor market to replay, so the golden-master is pinned at the math layer
// instead — the same guarantee, without a DB snapshot.)

import { describe, expect, test } from 'bun:test';
import { updateBelief } from '../src/bayes.ts';
import { makeEngineConfig } from '../src/config.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { MixtureBelief } from '../src/mixture.ts';
import { price } from '../src/pricing.ts';
import { StudentTBelief } from '../src/student_t.ts';
import type { BeliefModel, ContractSpec } from '../src/types.ts';

const cfg = makeEngineConfig(100, 10, {});

const SPECS: ContractSpec[] = [
  { type: 'LINEAR' },
  { type: 'CALL', strike: 105 },
  { type: 'BINARY_CALL', strike: 105 },
  { type: 'SPREAD', lower: 90, upper: 110 },
  { type: 'GAUSSIAN', center: 100, width: 8 },
];

interface Golden {
  make: () => BeliefModel;
  prices: Record<string, number>;
  update: { mean: number; var: number };
}

// Frozen reference (6 dp) — DO NOT edit to make a failing test pass; a change here
// means the legacy pricing/update math moved and must be justified.
const GOLDEN: Record<'gaussian' | 'mixture' | 'student_t', Golden> = {
  gaussian: {
    make: () => new GaussianBelief(100, 100),
    prices: {
      LINEAR: 100,
      CALL: 1.977966,
      BINARY_CALL: 0.308538,
      SPREAD: 0.682689,
      GAUSSIAN: 0.624695,
    },
    update: { mean: 101.333333, var: 66.666667 },
  },
  mixture: {
    make: () =>
      new MixtureBelief([
        { pi: 0.6, mu: 96, sigma2: 64 },
        { pi: 0.4, mu: 112, sigma2: 100 },
      ]),
    prices: {
      LINEAR: 102.4,
      CALL: 3.684935,
      BINARY_CALL: 0.381391,
      SPREAD: 0.602723,
      GAUSSIAN: 0.559647,
    },
    update: { mean: 102.554009, var: 108.075495 },
  },
  student_t: {
    make: () => new StudentTBelief(5, 100, 80),
    prices: {
      LINEAR: 100,
      CALL: 2.258855,
      BINARY_CALL: 0.300131,
      SPREAD: 0.685627,
      GAUSSIAN: 0.624468,
    },
    update: { mean: 101.6, var: 80 },
  },
};

describe('legacy models reprice identically (golden-master)', () => {
  for (const [name, g] of Object.entries(GOLDEN)) {
    test(`${name}: closed-form prices unchanged`, () => {
      const b = g.make();
      for (const spec of SPECS) {
        expect(price(spec, b)).toBeCloseTo(g.prices[spec.type] as number, 5);
      }
    });

    test(`${name}: post-update (signal 104, weight 0.5) unchanged`, () => {
      const u = updateBelief(g.make(), 104, 0.5, cfg);
      expect(u.mean()).toBeCloseTo(g.update.mean, 5);
      expect(u.variance()).toBeCloseTo(g.update.var, 5);
    });
  }
});
