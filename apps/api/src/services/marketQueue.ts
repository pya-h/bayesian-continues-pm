// Per-market serialization. All state-mutating market operations
// (lifecycle, trades, LP) run through `withMarketLock(marketId, fn)`, which chains
// them so only one runs at a time per market → sequential consistency for
// belief + cash. DB transactions additionally take `FOR UPDATE` on the market row
// so correctness holds even across processes.

const chains = new Map<string, Promise<unknown>>();

export function withMarketLock<T>(marketId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(marketId) ?? Promise.resolve();
  // Run fn after prev settles (regardless of prev's outcome).
  const next = prev.then(fn, fn);
  // Keep the chain alive but swallow errors so one failure doesn't poison the queue.
  chains.set(
    marketId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next as Promise<T>;
}
