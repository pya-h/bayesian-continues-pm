// Regression lock for the composer's client-side compatibility mirror
// (`disabledReason`). It must mirror the server `contractBeliefCompatible`
// guard on the *actual edited spec*, including the two rules that depend on
// user-editable params
// EXPONENTIAL rate cap (|rate|·outcomeSpan ≤ EXP_MAX_LOG_RANGE), and
// POLYNOMIAL degree-vs-ν on a Student-t market (needs ν threaded through).
// Earlier these checked a *default* spec with no ν, so a sharpened EXPONENTIAL
// rate / high-degree POLYNOMIAL showed as allowed in the UI then failed 400 at
// trade. These tests guard against that divergence reappearing.

import { describe, expect, test } from 'bun:test';
import { disabledReason } from '../src/components/ContractComposer.tsx';
import type { ContractSpec } from '../src/lib/types.ts';

describe('disabledReason mirrors the server compat guard on the edited spec', () => {
  test('EXPONENTIAL within the rate cap is allowed on a bounded Gaussian market', () => {
    const spec: ContractSpec = { type: 'EXPONENTIAL', center: 50, rate: 0.05 };
    expect(disabledReason(spec, 'gaussian', 0, 100, undefined)).toBeNull();
  });

  test('EXPONENTIAL with a sharpened rate exceeding |rate|·span is blocked (the editable-param bug)', () => {
    // |rate|·span = 0.5·100 = 50 > 20 ⇒ must be flagged, not silently allowed.
    const spec: ContractSpec = { type: 'EXPONENTIAL', center: 50, rate: 0.5 };
    const r = disabledReason(spec, 'gaussian', 0, 100, undefined);
    expect(r).not.toBeNull();
    expect(r).toContain('too steep');
  });

  test('EXPONENTIAL is always blocked on a Student-t (heavy-tail) market', () => {
    const spec: ContractSpec = { type: 'EXPONENTIAL', center: 50, rate: 0.05 };
    const r = disabledReason(spec, 'student_t', 0, 100, 5);
    expect(r).not.toBeNull();
    expect(r).toContain('infinite price');
  });

  test('POLYNOMIAL degree < ν is allowed on a bounded Student-t market', () => {
    // (θ−50)² ⇒ degree 2 < ν=5.
    const spec: ContractSpec = { type: 'POLYNOMIAL', coeffs: [2500, -100, 1] };
    expect(disabledReason(spec, 'student_t', 0, 100, 5)).toBeNull();
  });

  test('POLYNOMIAL degree ≥ ν is blocked on a bounded Student-t market (the un-threaded-ν bug)', () => {
    // degree 4 ≥ ν=3 ⇒ infinite moment; must be flagged.
    const spec: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 0, 0, 1] };
    const r = disabledReason(spec, 'student_t', 0, 100, 3);
    expect(r).not.toBeNull();
    expect(r).toContain('infinite moment');
  });

  test('unbounded contracts require a bounded outcome support', () => {
    const spec: ContractSpec = { type: 'POLYNOMIAL', coeffs: [0, 0, 1] };
    const r = disabledReason(spec, 'gaussian', null, null, undefined);
    expect(r).not.toBeNull();
    expect(r).toContain('bounded-outcome');
  });

  test('bounded/legacy contract types are never gated', () => {
    expect(disabledReason({ type: 'CALL', strike: 105 }, 'student_t', null, null, 5)).toBeNull();
    expect(
      disabledReason({ type: 'GAUSSIAN', center: 50, width: 8 }, 'gaussian', 0, 100, undefined),
    ).toBeNull();
  });
});
