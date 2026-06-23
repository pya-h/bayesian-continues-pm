import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ProjectedBelief,
  getProjectedBelief,
  setProjectedBelief,
  subscribeProjectedBelief,
} from '../src/lib/projectedBelief.ts';

// Module-level singleton — reset to empty after each test.
afterEach(() => {
  setProjectedBelief(null);
});

describe('getProjectedBelief / setProjectedBelief', () => {
  test('starts null and round-trips a published belief by reference', () => {
    expect(getProjectedBelief()).toBeNull();
    const b: ProjectedBelief = { mu: 100, sigma: 20 };
    setProjectedBelief(b);
    expect(getProjectedBelief()).toBe(b);
  });

  test('publishing null clears the current belief', () => {
    setProjectedBelief({ mu: 50, sigma: 5 });
    expect(getProjectedBelief()).not.toBeNull();
    setProjectedBelief(null);
    expect(getProjectedBelief()).toBeNull();
  });

  test('does not mutate the published belief object', () => {
    const b: ProjectedBelief = { mu: 12.5, sigma: 3.25 };
    setProjectedBelief(b);
    expect(getProjectedBelief()).toEqual({ mu: 12.5, sigma: 3.25 });
    expect(b).toEqual({ mu: 12.5, sigma: 3.25 });
  });
});

describe('subscribeProjectedBelief — shallow-equal guard', () => {
  test('fires once per actual change', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief({ mu: 1, sigma: 1 });
    setProjectedBelief({ mu: 2, sigma: 1 });
    setProjectedBelief(null);
    expect(calls).toBe(3);
    unsub();
  });

  test('re-publishing the SAME object reference is a no-op', () => {
    const b: ProjectedBelief = { mu: 100, sigma: 20 };
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief(b);
    setProjectedBelief(b);
    expect(calls).toBe(1);
    unsub();
  });

  test('a DIFFERENT object with equal mu AND sigma does not notify (shallow-equal guard)', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief({ mu: 100, sigma: 20 });
    setProjectedBelief({ mu: 100, sigma: 20 }); // structurally equal ⇒ guarded
    expect(calls).toBe(1);
    unsub();
  });

  test('a change in mu only still notifies', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief({ mu: 100, sigma: 20 });
    setProjectedBelief({ mu: 101, sigma: 20 });
    expect(calls).toBe(2);
    unsub();
  });

  test('a change in sigma only still notifies', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief({ mu: 100, sigma: 20 });
    setProjectedBelief({ mu: 100, sigma: 21 });
    expect(calls).toBe(2);
    unsub();
  });

  test('going from a value to null notifies, and null→null does not', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief(null); // already null ⇒ no-op
    expect(calls).toBe(0);
    setProjectedBelief({ mu: 5, sigma: 2 });
    expect(calls).toBe(1);
    setProjectedBelief(null); // value → null ⇒ notify
    expect(calls).toBe(2);
    setProjectedBelief(null); // null → null ⇒ no-op
    expect(calls).toBe(2);
    unsub();
  });

  test('null→value notifies (the && short-circuit when current is null)', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    // current starts null; next is a value ⇒ the `next && current` guard is false
    // so it must publish + notify.
    setProjectedBelief({ mu: 0, sigma: 0 });
    expect(calls).toBe(1);
    expect(getProjectedBelief()).toEqual({ mu: 0, sigma: 0 });
    unsub();
  });

  test('NaN mu is never shallow-equal to itself ⇒ always notifies (NaN !== NaN)', () => {
    let calls = 0;
    const unsub = subscribeProjectedBelief(() => {
      calls += 1;
    });
    setProjectedBelief({ mu: Number.NaN, sigma: 20 });
    setProjectedBelief({ mu: Number.NaN, sigma: 20 }); // NaN !== NaN ⇒ not guarded
    expect(calls).toBe(2);
    unsub();
  });

  test('all subscribers are notified, and unsubscribe is idempotent', () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeProjectedBelief(() => {
      a += 1;
    });
    const unsubB = subscribeProjectedBelief(() => {
      b += 1;
    });
    setProjectedBelief({ mu: 1, sigma: 1 });
    expect(a).toBe(1);
    expect(b).toBe(1);
    unsubA();
    unsubA(); // idempotent
    setProjectedBelief({ mu: 2, sigma: 2 });
    expect(a).toBe(1); // A stopped
    expect(b).toBe(2); // B still listening
    unsubB();
  });

  test('the current value is readable from inside a listener', () => {
    const b: ProjectedBelief = { mu: 7, sigma: 3 };
    let seen: ProjectedBelief | null = null;
    const unsub = subscribeProjectedBelief(() => {
      seen = getProjectedBelief();
    });
    setProjectedBelief(b);
    expect(seen).toBe(b);
    unsub();
  });
});
