import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type ChartView,
  getChartView,
  getHoverTheta,
  resetChartSync,
  setChartView,
  setHoverTheta,
} from '../src/lib/chartSync.ts';

// chartSync is a module singleton store (one market page mounted at a time). Reset
// it to the identity before AND after each test so state can't leak across tests.
beforeEach(() => resetChartSync());
afterEach(() => resetChartSync());

const IDENTITY: ChartView = { xMul: 1, xOff: 0, yMul: 1, yOff: 0 };

// NOTE: the store's `subscribe` is private (wired only into the useSyncExternalStore
// hooks), and there is no React renderer in this test harness. So these tests assert
// the store's *observable* contract through the public getters: value semantics, the
// reference-identity returned by getters (which is what drives useSyncExternalStore's
// snapshot equality — a stable reference on a no-op is exactly what prevents a tear /
// redundant re-render), and reset behaviour. The notify side-effect itself is gated by
// the same value-equality guards we exercise here.

describe('initial / reset state', () => {
  test('starts at the identity view with no hover', () => {
    expect(getChartView()).toEqual(IDENTITY);
    expect(getHoverTheta()).toBeNull();
  });

  test('resetChartSync restores identity + null hover after changes', () => {
    setChartView({ xMul: 2, xOff: 5, yMul: 1, yOff: 0 });
    setHoverTheta(42);
    resetChartSync();
    expect(getChartView()).toEqual(IDENTITY);
    expect(getHoverTheta()).toBeNull();
  });
});

describe('setChartView', () => {
  test('publishes a new view', () => {
    const next: ChartView = { xMul: 3, xOff: -10, yMul: 2, yOff: 4 };
    setChartView(next);
    expect(getChartView()).toEqual(next);
  });

  test('getChartView returns the exact stored reference (stable snapshot)', () => {
    const v: ChartView = { xMul: 1.5, xOff: 0, yMul: 1, yOff: 0 };
    setChartView(v);
    expect(getChartView()).toBe(v);
  });

  test('an equal-valued view is a no-op: the reference does NOT change', () => {
    // useSyncExternalStore relies on a stable snapshot reference for no-op writes
    // a structurally-equal view must leave getChartView pointing at the SAME object.
    setChartView({ xMul: 2, xOff: 1, yMul: 1, yOff: 0 });
    const ref = getChartView();
    setChartView({ xMul: 2, xOff: 1, yMul: 1, yOff: 0 }); // equal values, new object
    expect(getChartView()).toBe(ref); // unchanged reference ⇒ no emit
  });

  test('the very first equal write (still identity) is a no-op too', () => {
    const ref = getChartView();
    setChartView({ ...IDENTITY });
    expect(getChartView()).toBe(ref);
  });

  test('any single differing field swaps in the new reference', () => {
    for (const field of ['xMul', 'xOff', 'yMul', 'yOff'] as const) {
      resetChartSync();
      const before = getChartView();
      const next = { ...IDENTITY, [field]: 99 };
      setChartView(next);
      expect(getChartView()).not.toBe(before);
      expect(getChartView()).toBe(next);
      expect(getChartView()[field]).toBe(99);
    }
  });

  test('y-fields are tracked independently of x-fields', () => {
    setChartView({ xMul: 1, xOff: 0, yMul: 5, yOff: -3 });
    expect(getChartView()).toEqual({ xMul: 1, xOff: 0, yMul: 5, yOff: -3 });
  });
});

describe('setHoverTheta', () => {
  test('publishes a hovered θ and clears back to null', () => {
    setHoverTheta(12.5);
    expect(getHoverTheta()).toBe(12.5);
    setHoverTheta(null);
    expect(getHoverTheta()).toBeNull();
  });

  test('θ = 0 is a real value, distinct from null', () => {
    setHoverTheta(0);
    expect(getHoverTheta()).toBe(0);
    expect(getHoverTheta()).not.toBeNull();
  });

  test('negative θ is carried verbatim', () => {
    setHoverTheta(-7.25);
    expect(getHoverTheta()).toBe(-7.25);
  });

  test('overwrites the previous θ', () => {
    setHoverTheta(1);
    setHoverTheta(2);
    expect(getHoverTheta()).toBe(2);
  });
});

describe('resetChartSync', () => {
  test('clears both a non-identity view and a hover', () => {
    setChartView({ xMul: 2, xOff: 0, yMul: 1, yOff: 0 });
    setHoverTheta(5);
    resetChartSync();
    expect(getChartView()).toEqual(IDENTITY);
    expect(getHoverTheta()).toBeNull();
  });

  test('is idempotent — a second reset leaves the same identity reference', () => {
    setHoverTheta(9);
    resetChartSync();
    const ref = getChartView();
    resetChartSync();
    expect(getChartView()).toBe(ref); // already-identity reset keeps the same object
    expect(getHoverTheta()).toBeNull();
  });

  test('clears the hover even when the view is already identity', () => {
    setHoverTheta(9);
    expect(getChartView()).toEqual(IDENTITY); // view untouched
    resetChartSync();
    expect(getHoverTheta()).toBeNull();
    expect(getChartView()).toEqual(IDENTITY);
  });

  test('after reset, the stored view is the shared IDENTITY singleton', () => {
    // resetChartSync assigns the module-level IDENTITY; two resets yield the same ref.
    setChartView({ xMul: 4, xOff: 0, yMul: 1, yOff: 0 });
    resetChartSync();
    const a = getChartView();
    setChartView({ xMul: 4, xOff: 0, yMul: 1, yOff: 0 });
    resetChartSync();
    const b = getChartView();
    expect(a).toBe(b);
    expect(a).toEqual(IDENTITY);
  });
});
