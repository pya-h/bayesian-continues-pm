import { describe, expect, test } from 'bun:test';
import { type EngineConfig, GaussianBelief, MixtureBelief, StudentTBelief, price } from '@bmm/core';
import { beliefFromView } from '../src/lib/beliefFromView.ts';
import { estimateQuote } from '../src/lib/clientQuote.ts';
import type { Belief, ContractSpec } from '../src/lib/types.ts';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// computeSpread only reads s0/gamma/lambda/eta/qMax; cast a partial as the full config.
const ZERO_SPREAD = { s0: 0, gamma: 0, lambda: 0, eta: 0, qMax: 500 } as unknown as EngineConfig;
const REAL_CFG = {
  s0: 0.01,
  gamma: 0.0005,
  lambda: 0.5,
  eta: 0.05,
  qMax: 500,
} as unknown as EngineConfig;

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
      const q = estimateQuote({ spec, signedQ: 3, belief, cfg: ZERO_SPREAD, serverInventory: 0.4 });
      expect(close(q.fair, price(spec, belief))).toBe(true);
    }
  });

  // With every recomputed spread coefficient zeroed, `serverInventory` IS the whole
  // spread — so the exec-price arithmetic mirrors the old fixed-spread behaviour.
  test('a buy pays the ask: exec = fair + spread, totalCost > 0', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const q = estimateQuote({ spec, signedQ: 5, belief, cfg: ZERO_SPREAD, serverInventory: 0.5 });
    expect(close(q.spread.total, 0.5)).toBe(true);
    expect(close(q.execPrice, q.fair + 0.5)).toBe(true);
    expect(close(q.totalCost, q.execPrice * 5)).toBe(true);
    expect(q.totalCost).toBeGreaterThan(0);
  });

  test('a sell receives the bid: exec = fair − spread, totalCost < 0', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 110 };
    const q = estimateQuote({ spec, signedQ: -5, belief, cfg: ZERO_SPREAD, serverInventory: 0.5 });
    expect(close(q.execPrice, q.fair - 0.5)).toBe(true);
    expect(close(q.totalCost, q.execPrice * -5)).toBe(true);
    expect(q.totalCost).toBeLessThan(0);
  });

  test('the sell bid is floored at zero (never a negative price)', () => {
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 1000 };
    const q = estimateQuote({ spec, signedQ: -2, belief, cfg: ZERO_SPREAD, serverInventory: 5 });
    expect(q.execPrice).toBe(0);
    expect(Math.abs(q.totalCost)).toBe(0); // exactly zero magnitude (handles the −0 case)
  });

  test('a zero spread reproduces the mid for both sides', () => {
    const spec: ContractSpec = { type: 'LINEAR' };
    const buy = estimateQuote({ spec, signedQ: 1, belief, cfg: ZERO_SPREAD, serverInventory: 0 });
    const sell = estimateQuote({ spec, signedQ: -1, belief, cfg: ZERO_SPREAD, serverInventory: 0 });
    expect(close(buy.execPrice, mu)).toBe(true);
    expect(close(sell.execPrice, mu)).toBe(true);
  });

  // The live-preview fix: base / adverse-selection / volatility are recomputed from
  // (spec, belief, cfg) every call, so they MOVE with the dragged contract; only the
  // inventory term is carried verbatim from the last server quote.
  test('base / adverse-sel / volatility are recomputed; inventory is carried', () => {
    const near: ContractSpec = { type: 'CALL', strike: 100 };
    const far: ContractSpec = { type: 'CALL', strike: 130 };
    const qNear = estimateQuote({
      spec: near,
      signedQ: 5,
      belief,
      cfg: REAL_CFG,
      serverInventory: 0.42,
    });
    const qFar = estimateQuote({
      spec: far,
      signedQ: 5,
      belief,
      cfg: REAL_CFG,
      serverInventory: 0.42,
    });

    // base = s0·|fair|, volatility = eta·(σ/max(|μ|,σ))·|fair| — both track |fair|.
    expect(close(qNear.spread.base, 0.01 * Math.abs(qNear.fair))).toBe(true);
    const sigmaRel = sigma / Math.max(Math.abs(mu), sigma);
    expect(close(qNear.spread.volatility, 0.05 * sigmaRel * Math.abs(qNear.fair))).toBe(true);

    // The far (cheaper) call has a different fair → different base & volatility.
    expect(qNear.spread.base).not.toBeCloseTo(qFar.spread.base, 6);
    expect(qNear.spread.volatility).not.toBeCloseTo(qFar.spread.volatility, 6);
    expect(qNear.spread.adverseSelection).not.toBeCloseTo(qFar.spread.adverseSelection, 6);

    // inventory is the book-dependent term — carried verbatim from the server.
    expect(qNear.spread.inventory).toBe(0.42);
    expect(qFar.spread.inventory).toBe(0.42);
    // total = base + inventory + adverse + volatility
    const s = qNear.spread;
    expect(close(s.total, s.base + s.inventory + s.adverseSelection + s.volatility)).toBe(true);
  });

  test('degenerate σ ≤ 0 does not throw (beliefFromView clamps to a positive variance)', () => {
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 100 };
    const degenerate = beliefFromView({ kind: 'gaussian', mu: 100, sigma: 0, sigma2: 0 });
    const q = estimateQuote({
      spec,
      signedQ: 1,
      belief: degenerate,
      cfg: ZERO_SPREAD,
      serverInventory: 0.1,
    });
    expect(Number.isFinite(q.fair)).toBe(true);
    expect(close(q.fair, 0.5, 1e-6)).toBe(true); // at-the-money binary, σ→0 → Φ(0) = 0.5
  });

  test('fair prices a mixture / Student-t market against its TRUE belief, not a Gaussian', () => {
    const spec: ContractSpec = { type: 'BINARY_CALL', strike: 75 };

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
      cfg: ZERO_SPREAD,
      serverInventory: 0,
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

    const tView: Belief = { kind: 'student_t', mu: 70, sigma: 14, sigma2: 196, nu: 5 };
    const t = estimateQuote({
      spec,
      signedQ: 1,
      belief: beliefFromView(tView),
      cfg: ZERO_SPREAD,
      serverInventory: 0,
    });
    const tBelief = StudentTBelief.fromVariance(5, 70, 14 * 14);
    expect(close(t.fair, price(spec, tBelief))).toBe(true);
    expect(close(t.fair, price(spec, new GaussianBelief(70, 196)))).toBe(false);
  });
});
