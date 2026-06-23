import { describe, expect, test } from 'bun:test';
import { type BreakerInput, evalBreakers } from '../src/breakers.ts';

// A healthy snapshot: σ near genesis, tiny price move, cash well above reserve.
const OK: BreakerInput = {
  sigma: 1000,
  sigma0: 1000,
  priceMovePct: 0.01,
  cash: 100_000,
  reserve: 10_000,
};

describe('evalBreakers — MODEL.md §15.1', () => {
  test('a healthy market trips nothing', () => {
    expect(evalBreakers(OK)).toEqual([]);
  });

  test('belief divergence fires when σ > 3·σ₀ (alert)', () => {
    const a = evalBreakers({ ...OK, sigma: 3001 });
    expect(a).toHaveLength(1);
    expect(a[0]?.kind).toBe('belief_divergence');
    expect(a[0]?.action).toBe('alert');
    expect(a[0]?.severity).toBe('warning');
  });

  test('belief divergence does NOT fire exactly at 3·σ₀', () => {
    expect(evalBreakers({ ...OK, sigma: 3000 })).toEqual([]);
  });

  test('belief divergence is skipped when σ₀ is non-positive', () => {
    expect(evalBreakers({ ...OK, sigma: 9999, sigma0: 0 })).toEqual([]);
  });

  test('rapid price move > 10% suspends (critical)', () => {
    const a = evalBreakers({ ...OK, priceMovePct: 0.11 });
    expect(a).toHaveLength(1);
    expect(a[0]?.kind).toBe('rapid_price_move');
    expect(a[0]?.action).toBe('suspend');
    expect(a[0]?.severity).toBe('critical');
  });

  test('rapid price move uses absolute magnitude (down moves count)', () => {
    const a = evalBreakers({ ...OK, priceMovePct: -0.25 });
    expect(a[0]?.kind).toBe('rapid_price_move');
    expect(a[0]?.value).toBeCloseTo(0.25, 9);
  });

  test('insolvency: cash < 1.2× reserve rejects (critical)', () => {
    const a = evalBreakers({ ...OK, cash: 11_000, reserve: 10_000 });
    expect(a).toHaveLength(1);
    expect(a[0]?.kind).toBe('insolvency_risk');
    expect(a[0]?.action).toBe('reject');
    expect(a[0]?.severity).toBe('critical');
  });

  test('insolvency: 1.2×–1.5× reserve warns (approaching)', () => {
    const a = evalBreakers({ ...OK, cash: 14_000, reserve: 10_000 });
    expect(a).toHaveLength(1);
    expect(a[0]?.kind).toBe('insolvency_risk');
    expect(a[0]?.action).toBe('alert');
    expect(a[0]?.severity).toBe('warning');
  });

  test('insolvency is skipped when reserve is zero (empty book)', () => {
    expect(evalBreakers({ ...OK, cash: 0, reserve: 0 })).toEqual([]);
  });

  test('param rail fires when an adaptive parameter clamps (info/alert)', () => {
    const a = evalBreakers({ ...OK, paramRailHit: true });
    expect(a).toHaveLength(1);
    expect(a[0]?.kind).toBe('param_rail');
    expect(a[0]?.action).toBe('alert');
    expect(a[0]?.severity).toBe('info');
  });

  test('param rail does not fire when no rail is hit', () => {
    expect(evalBreakers({ ...OK, paramRailHit: false })).toEqual([]);
    expect(evalBreakers(OK)).toEqual([]); // undefined ⇒ off
  });

  test('multiple breakers fire together', () => {
    const a = evalBreakers({
      sigma: 5000,
      sigma0: 1000,
      priceMovePct: 0.5,
      cash: 1000,
      reserve: 10_000,
      paramRailHit: true,
    });
    const kinds = a.map((x) => x.kind).sort();
    expect(kinds).toEqual([
      'belief_divergence',
      'insolvency_risk',
      'param_rail',
      'rapid_price_move',
    ]);
  });

  test('thresholds are overridable', () => {
    // Tighten the price-move breaker to 5%; a 6% move now trips it.
    expect(evalBreakers({ ...OK, priceMovePct: 0.06 })).toEqual([]);
    const a = evalBreakers({ ...OK, priceMovePct: 0.06 }, { priceMovePct: 0.05 });
    expect(a[0]?.kind).toBe('rapid_price_move');
  });

  test('every alert carries its observed value and threshold', () => {
    const a = evalBreakers({ ...OK, sigma: 4000 });
    expect(a[0]?.value).toBe(4000);
    expect(a[0]?.threshold).toBe(3000);
  });
});
