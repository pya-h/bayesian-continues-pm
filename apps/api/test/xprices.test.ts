// Pure unit tests for the xprices oracle client (src/lib/xprices.ts).
// These DO NOT touch the DB or the network: `fetchImpl` is replaced via the
// exported `setXpricesFetch` test seam, and `nowMs` is pinned so freshness is
// deterministic. They run unconditionally (no `hasEnv` gate) — the only reason
// the suite needs `--env-file` at all is the api package's bunfig env-guard
// preload, which checks env *presence* but opens no connection.
// Coverage: fresh valid reading → ok; feed-flagged stale; missing / zero /
// negative / NaN price; missing / unparseable timestamp; age beyond the
// maxStalenessSec window (and exactly at the boundary); HTTP non-200; fetch
// rejection (network throw) / AbortError. The typed result shape (ok / reading /
// reason / stale) is asserted precisely.

import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../src/config.ts';
import { type PriceResult, fetchPrice, setXpricesFetch } from '../src/lib/xprices.ts';

// A fixed wall-clock for deterministic freshness math.
const NOW = Date.parse('2026-06-23T12:00:00.000Z');

function stubFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? (ok ? 200 : 500);
  return async () => ({
    ok,
    status,
    json: async () => body,
  });
}

function freshRaw(ageSec = 0, over: Record<string, unknown> = {}) {
  return {
    token_id: 'BTC',
    price: 64000.5,
    ema_price: 63950.25,
    confidence: 12.5,
    timestamp: new Date(NOW - ageSec * 1000).toISOString(),
    ...over,
  };
}

afterEach(() => {
  // Always restore the real fetch so a stub can't leak between tests.
  setXpricesFetch(null);
});

function asFail(r: PriceResult): { ok: false; reason: string; stale: boolean } {
  if (r.ok) throw new Error(`expected failure, got ok: ${JSON.stringify(r)}`);
  return r;
}

describe('fetchPrice — valid reading', () => {
  test('a fresh, finite, positive reading resolves ok with the parsed reading', async () => {
    setXpricesFetch(stubFetch(freshRaw(0)));
    const r = await fetchPrice('BTC', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.token).toBe('BTC');
    expect(r.reading.price).toBe(64000.5);
    expect(r.reading.emaPrice).toBe(63950.25);
    expect(r.reading.confidence).toBe(12.5);
    expect(r.reading.timestampMs).toBe(NOW);
    expect(r.reading.ageSec).toBe(0);
  });

  test('a reading well inside the staleness window is ok with a positive ageSec', async () => {
    setXpricesFetch(stubFetch(freshRaw(30)));
    const r = await fetchPrice('BTC', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.ageSec).toBeCloseTo(30, 6);
  });

  test('optional ema_price / confidence default to null when absent or non-numeric', async () => {
    setXpricesFetch(
      stubFetch(freshRaw(0, { ema_price: undefined, confidence: 'oops' as unknown })),
    );
    const r = await fetchPrice('BTC', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.emaPrice).toBeNull();
    expect(r.reading.confidence).toBeNull();
  });

  test('token falls back to the requested token when token_id is missing', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { token_id: undefined })));
    const r = await fetchPrice('ETH', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.token).toBe('ETH');
  });

  test('a reading exactly AT the staleness boundary is still ok (strict >)', async () => {
    // ageSec === maxStalenessSec is NOT rejected (guard is `ageSec > max`).
    setXpricesFetch(stubFetch(freshRaw(config.oracle.maxStalenessSec)));
    const r = await fetchPrice('BTC', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.ageSec).toBeCloseTo(config.oracle.maxStalenessSec, 6);
  });
});

describe('fetchPrice — stale / bad data → typed failure', () => {
  test('feed flagged stale:true is rejected as stale', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { stale: true })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('feed flagged stale');
    expect(f.stale).toBe(true);
  });

  test('missing price is rejected (stale)', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { price: undefined })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('no valid price in feed');
    expect(f.stale).toBe(true);
  });

  test('zero price is rejected (price must be > 0)', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { price: 0 })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('no valid price in feed');
    expect(f.stale).toBe(true);
  });

  test('negative price is rejected', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { price: -5 })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('no valid price in feed');
    expect(f.stale).toBe(true);
  });

  test('NaN price is rejected (not finite)', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { price: Number.NaN })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('no valid price in feed');
    expect(f.stale).toBe(true);
  });

  test('Infinity price is rejected (not finite)', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { price: Number.POSITIVE_INFINITY })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('no valid price in feed');
    expect(f.stale).toBe(true);
  });

  test('non-numeric price (wrong type) is rejected', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { price: '64000' as unknown })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('no valid price in feed');
    expect(f.stale).toBe(true);
  });

  test('missing timestamp is rejected (stale)', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { timestamp: undefined })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('feed missing timestamp');
    expect(f.stale).toBe(true);
  });

  test('unparseable timestamp string is rejected (Date.parse → NaN)', async () => {
    setXpricesFetch(stubFetch(freshRaw(0, { timestamp: 'not-a-date' })));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('feed missing timestamp');
    expect(f.stale).toBe(true);
  });

  test('a timestamp older than maxStalenessSec is rejected with a by-Ns reason', async () => {
    const ageSec = config.oracle.maxStalenessSec + 45;
    setXpricesFetch(stubFetch(freshRaw(ageSec)));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe(`feed stale by ${ageSec}s`);
    expect(f.stale).toBe(true);
  });

  test('just past the boundary (one second over) is rejected', async () => {
    const ageSec = config.oracle.maxStalenessSec + 1;
    setXpricesFetch(stubFetch(freshRaw(ageSec)));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.stale).toBe(true);
    expect(f.reason).toContain('feed stale by');
  });
});

describe('fetchPrice — transport failures → typed failure (stale:false)', () => {
  test('HTTP non-200 is surfaced with the status, not marked stale', async () => {
    setXpricesFetch(stubFetch({}, { ok: false, status: 503 }));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('xprices HTTP 503');
    expect(f.stale).toBe(false);
  });

  test('a 404 is surfaced with its status', async () => {
    setXpricesFetch(stubFetch({}, { ok: false, status: 404 }));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toBe('xprices HTTP 404');
    expect(f.stale).toBe(false);
  });

  test('a network throw (fetch rejection) is caught as unreachable, not stale', async () => {
    setXpricesFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toContain('xprices unreachable');
    expect(f.reason).toContain('ECONNREFUSED');
    expect(f.stale).toBe(false);
  });

  test('an AbortError (timeout path) is caught as unreachable', async () => {
    // Simulate the AbortController firing: reject with a DOMException-like AbortError.
    setXpricesFetch(async (_url, init) => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      void init?.signal;
      throw err;
    });
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toContain('xprices unreachable');
    expect(f.reason).toContain('aborted');
    expect(f.stale).toBe(false);
  });

  test('a rejection thrown from res.json() is caught as unreachable', async () => {
    setXpricesFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      },
    }));
    const f = asFail(await fetchPrice('BTC', NOW));
    expect(f.reason).toContain('xprices unreachable');
    expect(f.reason).toContain('invalid json');
    expect(f.stale).toBe(false);
  });
});

describe('fetchPrice — request construction', () => {
  test('builds the URL from config.baseUrl + token and passes an abort signal', async () => {
    let seenUrl = '';
    let sawSignal = false;
    setXpricesFetch(async (url, init) => {
      seenUrl = url;
      sawSignal = init?.signal instanceof AbortSignal;
      return { ok: true, status: 200, json: async () => freshRaw(0) };
    });
    await fetchPrice('BTC', NOW);
    const expectedBase = config.oracle.baseUrl.replace(/\/$/, '');
    expect(seenUrl).toBe(`${expectedBase}/prices/BTC`);
    expect(sawSignal).toBe(true);
  });

  test('the token is URL-encoded into the path', async () => {
    let seenUrl = '';
    setXpricesFetch(async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => freshRaw(0) };
    });
    await fetchPrice('BTC/USD', NOW);
    expect(seenUrl).toContain('/prices/BTC%2FUSD');
  });
});
