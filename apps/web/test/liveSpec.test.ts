import { afterEach, describe, expect, test } from 'bun:test';
import { getLiveSpec, setLiveSpec, subscribeLiveSpec } from '../src/lib/liveSpec.ts';
import type { ContractSpec } from '../src/lib/types.ts';

// The store is a module-level singleton; reset it to the empty state after each
// test so cases don't leak into one another.
afterEach(() => {
  setLiveSpec(null);
});

describe('getLiveSpec / setLiveSpec', () => {
  test('starts null and round-trips a published spec by reference', () => {
    expect(getLiveSpec()).toBeNull();
    const spec: ContractSpec = { type: 'CALL', strike: 60 };
    setLiveSpec(spec);
    expect(getLiveSpec()).toBe(spec); // same reference, not a copy
  });

  test('publishing null clears the current spec', () => {
    setLiveSpec({ type: 'PUT', strike: 40 });
    expect(getLiveSpec()).not.toBeNull();
    setLiveSpec(null);
    expect(getLiveSpec()).toBeNull();
  });

  test('does not mutate the published spec object', () => {
    const spec: ContractSpec = { type: 'SPREAD', lower: 95, upper: 115 };
    const snapshot = JSON.stringify(spec);
    setLiveSpec(spec);
    expect(JSON.stringify(getLiveSpec())).toBe(snapshot);
    expect(getLiveSpec()).toEqual({ type: 'SPREAD', lower: 95, upper: 115 });
  });

  test('stores any ContractSpec shape verbatim', () => {
    const specs: ContractSpec[] = [
      { type: 'LINEAR' },
      { type: 'CALL', strike: 60 },
      { type: 'PUT', strike: 40 },
      { type: 'BINARY_CALL', strike: 105 },
      { type: 'BINARY_PUT', strike: 95 },
      { type: 'SPREAD', lower: 95, upper: 115 },
      { type: 'GAUSSIAN', center: 100, width: 10 },
      { type: 'SKEW_GAUSSIAN', center: 100, widthLeft: 5, widthRight: 9 },
      { type: 'TENT', center: 100, width: 12 },
      { type: 'TRAPEZOID', lower: 90, upper: 110, width: 4 },
      { type: 'SIGMOID', center: 100, width: 6 },
      { type: 'POLYNOMIAL', coeffs: [0, 0, 1] },
      { type: 'EXPONENTIAL', center: 50, rate: 0.05 },
    ];
    for (const spec of specs) {
      setLiveSpec(spec);
      expect(getLiveSpec()).toBe(spec);
    }
  });
});

describe('subscribeLiveSpec', () => {
  test('fires a listener once per actual change', () => {
    let calls = 0;
    const unsub = subscribeLiveSpec(() => {
      calls += 1;
    });
    setLiveSpec({ type: 'CALL', strike: 60 });
    setLiveSpec({ type: 'PUT', strike: 40 });
    setLiveSpec(null);
    expect(calls).toBe(3);
    unsub();
  });

  test('reference-equality guard: re-publishing the SAME object does not notify', () => {
    const spec: ContractSpec = { type: 'CALL', strike: 60 };
    let calls = 0;
    const unsub = subscribeLiveSpec(() => {
      calls += 1;
    });
    setLiveSpec(spec);
    setLiveSpec(spec); // identical reference ⇒ no-op, no notification
    setLiveSpec(spec);
    expect(calls).toBe(1);
    unsub();
  });

  test('an equal-but-DIFFERENT object still notifies (guard is identity, not deep-equal)', () => {
    let calls = 0;
    const unsub = subscribeLiveSpec(() => {
      calls += 1;
    });
    setLiveSpec({ type: 'CALL', strike: 60 });
    setLiveSpec({ type: 'CALL', strike: 60 }); // structurally equal, new reference
    expect(calls).toBe(2);
    unsub();
  });

  test('publishing null when already null does not notify', () => {
    let calls = 0;
    const unsub = subscribeLiveSpec(() => {
      calls += 1;
    });
    setLiveSpec(null); // already null at start
    expect(calls).toBe(0);
    unsub();
  });

  test('all subscribers are notified', () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeLiveSpec(() => {
      a += 1;
    });
    const unsubB = subscribeLiveSpec(() => {
      b += 1;
    });
    setLiveSpec({ type: 'CALL', strike: 60 });
    expect(a).toBe(1);
    expect(b).toBe(1);
    unsubA();
    unsubB();
  });

  test('subscribe returns an idempotent unsubscribe that stops notifications', () => {
    let calls = 0;
    const unsub = subscribeLiveSpec(() => {
      calls += 1;
    });
    setLiveSpec({ type: 'CALL', strike: 60 });
    expect(calls).toBe(1);
    unsub();
    unsub(); // calling twice is safe
    setLiveSpec({ type: 'PUT', strike: 40 });
    expect(calls).toBe(1); // no further notifications
  });

  test('the current value is readable from inside a listener (set happens before notify)', () => {
    const spec: ContractSpec = { type: 'GAUSSIAN', center: 100, width: 10 };
    let seen: ContractSpec | null = null;
    const unsub = subscribeLiveSpec(() => {
      seen = getLiveSpec();
    });
    setLiveSpec(spec);
    expect(seen).toBe(spec);
    unsub();
  });
});
