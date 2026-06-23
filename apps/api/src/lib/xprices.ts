// xprices client — the in-house price service (pyth-pal) that backs `api`-mode
// oracle resolution. A market configured with `oracle_mode='api'` resolves
// to the spot price of its `oracle_token` at the deadline.
// Endpoint: `GET {baseUrl}/prices/{token}` →
// { token_id, price, ema_price, confidence, timestamp, stale? }
// No auth. A reading is only usable to resolve a market if it is FRESH — not
// flagged `stale`, has a finite positive price, and a `timestamp` within
// `maxStalenessSec` of now. A bad/missing reading is surfaced as a typed failure
// so the scheduler can SUSPEND + alert instead of resolving on junk data.

import { config } from '../config.ts';

interface XpricesRaw {
  token_id?: string;
  price?: number;
  ema_price?: number;
  confidence?: number;
  timestamp?: string;
  stale?: boolean;
}

export interface PriceReading {
  token: string;
  price: number;
  emaPrice: number | null;
  confidence: number | null;
  timestampMs: number;
  ageSec: number;
}

export type PriceResult =
  | { ok: true; reading: PriceReading }
  | { ok: false; reason: string; stale: boolean };

// Allow tests to inject a deterministic fetch (no live network in CI).
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

let fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike;

export function setXpricesFetch(fn: FetchLike | null): void {
  fetchImpl = (fn ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
}

// Fetch the current price of `token` (e.g. "BTC"). `nowMs` defaults to wall-clock
// but is injectable so tests can pin freshness deterministically. Never throws —
// every failure mode returns `{ ok: false... }`.
export async function fetchPrice(token: string, nowMs = Date.now()): Promise<PriceResult> {
  const url = `${config.oracle.baseUrl.replace(/\/$/, '')}/prices/${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.oracle.fetchTimeoutMs);

  let raw: XpricesRaw;
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `xprices HTTP ${res.status}`, stale: false };
    raw = (await res.json()) as XpricesRaw;
  } catch (e) {
    return { ok: false, reason: `xprices unreachable: ${String(e)}`, stale: false };
  } finally {
    clearTimeout(timer);
  }

  if (raw.stale === true) return { ok: false, reason: 'feed flagged stale', stale: true };
  if (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price <= 0) {
    return { ok: false, reason: 'no valid price in feed', stale: true };
  }
  const ts = raw.timestamp ? Date.parse(raw.timestamp) : Number.NaN;
  if (!Number.isFinite(ts)) return { ok: false, reason: 'feed missing timestamp', stale: true };
  const ageSec = (nowMs - ts) / 1000;
  if (ageSec > config.oracle.maxStalenessSec) {
    return { ok: false, reason: `feed stale by ${Math.round(ageSec)}s`, stale: true };
  }

  return {
    ok: true,
    reading: {
      token: raw.token_id ?? token,
      price: raw.price,
      emaPrice: typeof raw.ema_price === 'number' ? raw.ema_price : null,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
      timestampMs: ts,
      ageSec,
    },
  };
}
