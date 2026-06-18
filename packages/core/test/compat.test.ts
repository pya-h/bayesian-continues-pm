import { describe, expect, test } from 'bun:test';
import {
  BELIEF_TAIL,
  type ContractSpec,
  type ModelTag,
  type TailKind,
  contractBeliefCompatible,
} from '../src/index.ts';

describe('BELIEF_TAIL', () => {
  test('Gaussian-derived models decay Gaussian; only Student-t is heavy-tailed', () => {
    const gaussianTailed: ModelTag[] = ['gaussian', 'mixture', 'gen_basis', 'gen_exact'];
    for (const m of gaussianTailed) expect(BELIEF_TAIL[m]).toBe('gaussian');
    expect(BELIEF_TAIL.student_t).toBe('polynomial');
  });

  test('covers every model tag', () => {
    const tags: ModelTag[] = ['gaussian', 'student_t', 'mixture', 'gen_basis', 'gen_exact'];
    for (const m of tags) expect(BELIEF_TAIL[m]).toBeDefined();
    expect(Object.keys(BELIEF_TAIL).sort()).toEqual([...tags].sort());
  });
});

describe('contractBeliefCompatible — v1 + bounded G5.1 contracts (always compatible)', () => {
  test('accepts every bounded/legacy contract under both tails, bounded or not', () => {
    const specs: ContractSpec[] = [
      { type: 'LINEAR' },
      { type: 'CALL', strike: 100 },
      { type: 'PUT', strike: 100 },
      { type: 'BINARY_CALL', strike: 100 },
      { type: 'BINARY_PUT', strike: 100 },
      { type: 'SPREAD', lower: 90, upper: 110 },
      { type: 'GAUSSIAN', center: 100, width: 5 },
      { type: 'SKEW_GAUSSIAN', center: 100, widthLeft: 4, widthRight: 8 },
      { type: 'TENT', center: 100, width: 6 },
      { type: 'TRAPEZOID', lower: 95, upper: 105, width: 4 },
      { type: 'SIGMOID', center: 100, width: 3 },
    ];
    const tails: TailKind[] = ['gaussian', 'polynomial'];
    for (const spec of specs) {
      for (const tail of tails) {
        expect(contractBeliefCompatible(spec, { tail, outcomeBounded: false }).ok).toBe(true);
        expect(contractBeliefCompatible(spec, { tail, outcomeBounded: true }).ok).toBe(true);
      }
    }
  });
});

describe('contractBeliefCompatible — G5.2 unbounded contracts (gated)', () => {
  const poly: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 1] }; // θ², degree 2
  const expo: ContractSpec = { type: 'EXPONENTIAL', center: 100, rate: 0.05 };

  test('both require a bounded-outcome market', () => {
    for (const spec of [poly, expo]) {
      const r = contractBeliefCompatible(spec, { tail: 'gaussian', outcomeBounded: false });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/bounded-outcome/);
    }
  });

  test('both fine on a bounded Gaussian-tailed market', () => {
    const ctx = { tail: 'gaussian' as const, outcomeBounded: true, outcomeSpan: 200 };
    expect(contractBeliefCompatible(poly, ctx).ok).toBe(true);
    expect(contractBeliefCompatible(expo, ctx).ok).toBe(true);
  });

  test('EXPONENTIAL is rejected on a Student-t (polynomial-tail) belief — infinite price', () => {
    const r = contractBeliefCompatible(expo, {
      tail: 'polynomial',
      nu: 5,
      outcomeBounded: true,
      outcomeSpan: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/infinite price|Student-t/);
  });

  test('EXPONENTIAL rate capped by the outcome span (dynamic-range guard)', () => {
    const steep: ContractSpec = { type: 'EXPONENTIAL', center: 0, rate: 1 };
    const r = contractBeliefCompatible(steep, {
      tail: 'gaussian',
      outcomeBounded: true,
      outcomeSpan: 100, // |a|·span = 100 ≫ 20
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too steep/);
  });

  test('POLYNOMIAL finite on Student-t iff degree < ν', () => {
    const span = 200;
    const deg2: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 1] };
    expect(
      contractBeliefCompatible(deg2, {
        tail: 'polynomial',
        nu: 5,
        outcomeBounded: true,
        outcomeSpan: span,
      }).ok,
    ).toBe(true);
    const r = contractBeliefCompatible(deg2, {
      tail: 'polynomial',
      nu: 2,
      outcomeBounded: true,
      outcomeSpan: span,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/infinite moment|degree < ν/);
    // degree 4 right at ν=4 is rejected (needs strictly <).
    const deg4: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 0, 0, 1] };
    expect(
      contractBeliefCompatible(deg4, {
        tail: 'polynomial',
        nu: 4,
        outcomeBounded: true,
        outcomeSpan: span,
      }).ok,
    ).toBe(false);
  });

  test('POLYNOMIAL unrestricted by ν on a Gaussian-tailed belief', () => {
    const deg4: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 0, 0, 1] };
    expect(
      contractBeliefCompatible(deg4, { tail: 'gaussian', outcomeBounded: true, outcomeSpan: 50 })
        .ok,
    ).toBe(true);
  });
});
