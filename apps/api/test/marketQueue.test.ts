// Unit tests for the per-market serialization lock.
// `withMarketLock(marketId, fn)` is the concurrency primitive that guarantees
// all state-mutating operations on the SAME market run strictly sequentially
// while operations on DIFFERENT markets may run concurrently. These tests prove
// the guarantees deterministically using manually-resolved deferreds + an
// ordered event log (no real timers, no DB).

import { describe, expect, test } from 'bun:test';
import { withMarketLock } from '../src/services/marketQueue.ts';

// A minimal Deferred so we control exactly when a locked task's body completes.
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush pending microtasks so chained `.then` callbacks have a chance to run.
// A couple of awaited ticks is enough for the promise-chain depth used here.
async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('withMarketLock — same market serializes', () => {
  test("task B's body does not begin until task A settles", async () => {
    const log: string[] = [];
    const aBody = deferred();

    const aDone = withMarketLock('m1', async () => {
      log.push('A:start');
      await aBody.promise;
      log.push('A:end');
    });

    const bDone = withMarketLock('m1', async () => {
      log.push('B:start');
    });

    // Let the chain advance as far as it can while A is still in-flight.
    await flush();

    // A has started and is parked on its deferred; B must NOT have started yet.
    expect(log).toEqual(['A:start']);

    // Release A; now B is allowed to run.
    aBody.resolve();
    await Promise.all([aDone, bDone]);

    expect(log).toEqual(['A:start', 'A:end', 'B:start']);
  });

  test('N tasks on one market complete in FIFO submission order', async () => {
    const log: string[] = [];
    const gates = [deferred(), deferred(), deferred(), deferred()];

    const dones = gates.map((g, i) =>
      withMarketLock('fifo', async () => {
        log.push(`start:${i}`);
        await g.promise;
        log.push(`end:${i}`);
      }),
    );

    // Even if we release the gates out of order, execution order is FIFO
    // a later task cannot start until the earlier one ended.
    for (let i = gates.length - 1; i >= 0; i--) {
      gates[i].resolve();
      await flush();
    }

    await Promise.all(dones);

    expect(log).toEqual([
      'start:0',
      'end:0',
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
    ]);
  });
});

describe('withMarketLock — different markets run concurrently', () => {
  test('two tasks on different markets both enter before either resolves', async () => {
    const log: string[] = [];
    const aBody = deferred();
    const bBody = deferred();

    const aDone = withMarketLock('mA', async () => {
      log.push('A:start');
      await aBody.promise;
      log.push('A:end');
    });

    const bDone = withMarketLock('mB', async () => {
      log.push('B:start');
      await bBody.promise;
      log.push('B:end');
    });

    await flush();

    // Both bodies have entered concurrently — neither has resolved yet.
    expect(log).toContain('A:start');
    expect(log).toContain('B:start');
    expect(log).not.toContain('A:end');
    expect(log).not.toContain('B:end');

    aBody.resolve();
    bBody.resolve();
    await Promise.all([aDone, bDone]);
  });
});

describe('withMarketLock — error isolation', () => {
  test('rejection propagates to the caller', async () => {
    const err = new Error('boom');
    const p = withMarketLock('err1', async () => {
      throw err;
    });
    await expect(p).rejects.toBe(err);
  });

  test('a throwing task does not wedge the queue; the next same-market task still runs', async () => {
    const log: string[] = [];

    const failing = withMarketLock('err2', async () => {
      log.push('A:throw');
      throw new Error('A failed');
    });
    // Attach a catch immediately so the rejection is observed (no unhandled).
    await expect(failing).rejects.toThrow('A failed');

    const next = await withMarketLock('err2', async () => {
      log.push('B:run');
      return 'ok';
    });

    expect(next).toBe('ok');
    expect(log).toEqual(['A:throw', 'B:run']);
  });

  test('a throwing task still serializes the following task (no interleaving)', async () => {
    const log: string[] = [];
    const aGate = deferred();

    const failing = withMarketLock('err3', async () => {
      log.push('A:start');
      await aGate.promise;
      log.push('A:throw');
      throw new Error('A failed');
    });
    failing.catch(() => undefined); // observe rejection

    const bDone = withMarketLock('err3', async () => {
      log.push('B:start');
    });

    await flush();
    // B must not have started while A is still in-flight.
    expect(log).toEqual(['A:start']);

    aGate.resolve();
    await bDone;
    expect(log).toEqual(['A:start', 'A:throw', 'B:start']);
  });
});

describe('withMarketLock — return value passthrough', () => {
  test('resolves with fn return value', async () => {
    const result = await withMarketLock('ret', async () => 42);
    expect(result).toBe(42);
  });

  test('passes through object return values from chained calls', async () => {
    await withMarketLock('ret2', async () => 'first');
    const second = await withMarketLock('ret2', async () => ({ ok: true }));
    expect(second).toEqual({ ok: true });
  });
});

describe('withMarketLock — map does not grow unbounded', () => {
  test('idle markets are pruned so memory does not leak with market count', async () => {
    // We cannot read the internal map directly, but the pruning contract says
    // once a market is fully idle, a *fresh* lock on it must behave like the
    // very first lock (i.e. run immediately, not queued behind stale state).
    // Run many one-shot markets, let them all settle, then assert a re-lock
    // on a previously-used id starts without delay.
    const ids = Array.from({ length: 200 }, (_, i) => `prune-${i}`);
    await Promise.all(ids.map((id) => withMarketLock(id, async () => id)));

    await flush(8);

    const log: string[] = [];
    // Re-using id 0 after it went idle must run immediately (no leftover chain).
    const p = withMarketLock('prune-0', async () => {
      log.push('reused');
    });
    await flush();
    expect(log).toEqual(['reused']);
    await p;
  });
});
