// Unit tests for extractSignal (signal.ts) — the trade → (signal, weight) decoder
// that drives the Bayesian learning loop. Covers every contract routing (directional
// point/range bets, the G5 extension shapes, the shape-only POLYNOMIAL neutral case)
// buy AND sell, the σ_ε-free weight formula, the intensity clamp, and the noise gate.
// Reference arithmetic (so the expectations are independent hand-computations, not a
// re-run of the code): belief N(100, 12²) ⇒ μ=100, σ=12. cfg = makeEngineConfig(100,12)
// ⇒ α=1, β=1, qMax=500, qThreshold=10. For |q|=120: intensity ι = 120/500 = 0.24, so
// • directional anchor step α·σ·(1+ι) = 12·1.24 = 14.88
// • LINEAR step β·σ·ι = 12·0.24 = 2.88
// • weight w = ι·(1−e^{−|q|/qTh}) = 0.24·(1−e^{−12}).

import { describe, expect, test } from 'bun:test';
import { makeEngineConfig } from '../src/config.ts';
import { GaussianBelief } from '../src/gaussian.ts';
import { extractSignal } from '../src/signal.ts';
import type { BeliefModel, ContractSpec } from '../src/types.ts';

const cfg = makeEngineConfig(100, 12); // σ_ε=12, α=1, β=1, qMax=500, qTh=10
const belief = new GaussianBelief(100, 144); // μ=100, σ=12
const Q = 120; // ⇒ ι=0.24
const W120 = 0.24 * (1 - Math.exp(-120 / 10)); // exact weight for |q|=120

const sig = (spec: ContractSpec, q: number) => extractSignal(spec, q, belief, cfg).signal;
const wt = (spec: ContractSpec, q: number) => extractSignal(spec, q, belief, cfg).weight;

describe('extractSignal — directional contracts', () => {
  test('LINEAR: buy pushes above μ, sell below, by β·σ·ι (symmetric)', () => {
    expect(sig({ type: 'LINEAR' }, Q)).toBeCloseTo(100 + 2.88, 9); // 102.88
    expect(sig({ type: 'LINEAR' }, -Q)).toBeCloseTo(100 - 2.88, 9); // 97.12
    // buy(+q) and sell(−q) are mirror images about μ
    expect(sig({ type: 'LINEAR' }, Q) + sig({ type: 'LINEAR' }, -Q)).toBeCloseTo(200, 9);
  });

  test('CALL: anchored at strike, ±α·σ·(1+ι); BINARY_CALL is identical', () => {
    const call: ContractSpec = { type: 'CALL', strike: 110 };
    expect(sig(call, Q)).toBeCloseTo(110 + 14.88, 9); // 124.88 (bullish buy)
    expect(sig(call, -Q)).toBeCloseTo(110 - 14.88, 9); // 95.12 (sell)
    expect(sig({ type: 'BINARY_CALL', strike: 110 }, Q)).toBeCloseTo(sig(call, Q), 12);
  });

  test('PUT: bearish — buy pushes below strike; BINARY_PUT identical', () => {
    const put: ContractSpec = { type: 'PUT', strike: 90 };
    expect(sig(put, Q)).toBeCloseTo(90 - 14.88, 9); // 75.12
    expect(sig(put, -Q)).toBeCloseTo(90 + 14.88, 9); // 104.88
    expect(sig({ type: 'BINARY_PUT', strike: 90 }, Q)).toBeCloseTo(sig(put, Q), 12);
  });
});

describe('extractSignal — point & range bets (pointBet)', () => {
  test('GAUSSIAN buy lands exactly on the center c (no ι scaling on a buy)', () => {
    expect(sig({ type: 'GAUSSIAN', center: 105, width: 4 }, Q)).toBe(105);
    expect(sig({ type: 'GAUSSIAN', center: 88, width: 4 }, Q)).toBe(88);
  });

  test('GAUSSIAN sell pushes AWAY from c along sign(μ−c)', () => {
    // c above μ (105>100): sign(μ−c)=−1 ⇒ μ − α·σ·(1+ι) = 100 − 14.88
    expect(sig({ type: 'GAUSSIAN', center: 105, width: 4 }, -Q)).toBeCloseTo(85.12, 9);
    // c below μ (95<100): sign(μ−c)=+1 ⇒ μ + 14.88
    expect(sig({ type: 'GAUSSIAN', center: 95, width: 4 }, -Q)).toBeCloseTo(114.88, 9);
  });

  test('SKEW_GAUSSIAN and TENT route through the same center pointBet as GAUSSIAN', () => {
    const g = sig({ type: 'GAUSSIAN', center: 107, width: 3 }, Q);
    expect(sig({ type: 'SKEW_GAUSSIAN', center: 107, widthLeft: 3, widthRight: 5 }, Q)).toBe(g);
    expect(sig({ type: 'TENT', center: 107, width: 3 }, Q)).toBe(g);
  });

  test('SPREAD/TRAPEZOID target the midpoint (lower+upper)/2', () => {
    const spread: ContractSpec = { type: 'SPREAD', lower: 80, upper: 120 }; // mid=100=μ
    expect(sig(spread, Q)).toBe(100); // buy → midpoint
    // sell with μ==midpoint: sign(0)→0, `|| 1` defaults to +1 ⇒ μ + 14.88
    expect(sig(spread, -Q)).toBeCloseTo(114.88, 9);
    // TRAPEZOID shares the route; an off-μ midpoint buys to that midpoint
    expect(sig({ type: 'TRAPEZOID', lower: 60, upper: 80, width: 5 }, Q)).toBe(70);
  });
});

describe('extractSignal — extension contracts', () => {
  test('SIGMOID is bullish like a CALL struck at its center c', () => {
    expect(sig({ type: 'SIGMOID', center: 110, width: 2 }, Q)).toBeCloseTo(
      sig({ type: 'CALL', strike: 110 }, Q),
      12,
    );
    expect(sig({ type: 'SIGMOID', center: 110, width: 2 }, -Q)).toBeCloseTo(95.12, 9);
  });

  test('EXPONENTIAL direction follows sign(rate): rate>0 bullish, rate<0 bearish', () => {
    // around μ: bullish buy ⇒ μ + 14.88; bearish buy ⇒ μ − 14.88
    expect(sig({ type: 'EXPONENTIAL', center: 100, rate: 0.5 }, Q)).toBeCloseTo(114.88, 9);
    expect(sig({ type: 'EXPONENTIAL', center: 100, rate: -0.5 }, Q)).toBeCloseTo(85.12, 9);
    // flipping the rate sign flips the signal about μ
    const up = sig({ type: 'EXPONENTIAL', center: 100, rate: 0.5 }, Q);
    const dn = sig({ type: 'EXPONENTIAL', center: 100, rate: -0.5 }, Q);
    expect(up + dn).toBeCloseTo(200, 9);
    // rate exactly 0 → sign(0)||1 = +1 (bullish fallback), not NaN
    expect(sig({ type: 'EXPONENTIAL', center: 100, rate: 0 }, Q)).toBeCloseTo(114.88, 9);
  });

  test('POLYNOMIAL is a shape bet: location-neutral signal == μ for buy and sell', () => {
    const poly: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 1] }; // θ²
    expect(sig(poly, Q)).toBe(100);
    expect(sig(poly, -Q)).toBe(100);
    // ...but it still carries a non-zero weight (it prices/reserves; it just doesn't move μ)
    expect(wt(poly, Q)).toBeCloseTo(W120, 12);
  });
});

describe('extractSignal — weight & intensity', () => {
  test('weight follows ι·(1−e^{−|q|/qTh}) and is sign-independent', () => {
    expect(wt({ type: 'LINEAR' }, Q)).toBeCloseTo(W120, 12);
    expect(wt({ type: 'LINEAR' }, -Q)).toBeCloseTo(W120, 12); // |q| only
  });

  test('intensity is clamped to 1: a fill at qMax and one far above it agree', () => {
    const call: ContractSpec = { type: 'CALL', strike: 110 };
    // both have ι=1 ⇒ (1+ι)=2 ⇒ signal = 110 + 12·2 = 134
    expect(sig(call, cfg.qMax)).toBeCloseTo(134, 9);
    expect(sig(call, cfg.qMax * 5)).toBeCloseTo(134, 9);
    expect(sig(call, cfg.qMax)).toBe(sig(call, cfg.qMax * 5));
    // weight stays ≤ 1 even for an oversized (solvency-gated) fill
    expect(wt(call, cfg.qMax * 5)).toBeLessThanOrEqual(1);
    expect(wt(call, cfg.qMax * 5)).toBeGreaterThan(0.99);
  });

  test('noise gate: a tiny trade is almost zero weight, a zero trade is exactly zero', () => {
    expect(wt({ type: 'LINEAR' }, 1)).toBeLessThan(0.001); // 0.002·(1−e^{−0.1}) ≈ 1.9e-4
    expect(wt({ type: 'LINEAR' }, 0)).toBe(0); // ι=0
    // a zero-size trade leaves the location at μ (dir defaults to +1, ι=0)
    expect(sig({ type: 'LINEAR' }, 0)).toBe(100);
  });
});

describe('extractSignal — belief-agnostic (reads only mean & stddev)', () => {
  test('uses belief.mean()/stddev(), not the concrete kind', () => {
    // a minimal stub belief: only mean/stddev are consulted
    const stub = {
      kind: 'gaussian',
      mean: () => 50,
      stddev: () => 4,
    } as unknown as BeliefModel;
    // LINEAR buy of 250 ⇒ ι=0.5 ⇒ 50 + β·4·0.5 = 52
    expect(extractSignal({ type: 'LINEAR' }, 250, stub, cfg).signal).toBeCloseTo(52, 9);
    // CALL buy ⇒ K + α·4·(1+0.5) = 60 + 6 = 66
    expect(extractSignal({ type: 'CALL', strike: 60 }, 250, stub, cfg).signal).toBeCloseTo(66, 9);
  });
});
