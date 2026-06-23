// Centralized env config. Reads from process.env (Bun loads.env via --env-file).
// Note: the DATABASE_URL is parsed in db/url.ts (parseDbUrl) — kept there so DB
// tooling (migrate/drizzle-kit) doesn't depend on this module.

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be a number, got "${v}"`);
  return n;
}

function jwtSecret(): string {
  const v = process.env.JWT_SECRET;
  if (v) return v;
  // A hardcoded fallback is a dev convenience only — in production every token
  // would be forgeable by anyone who reads the source. Refuse to boot.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return 'dev-insecure-secret-change-me';
}

export const config = {
  port: num('PORT', 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  jwtSecret: jwtSecret(),
  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    // password is only strictly required when seeding; tolerate absence at boot.
    password: process.env.ADMIN_PASSWORD ?? '',
  },
  reserve: {
    // Used by the trade engine's solvency check.
    mcSamples: num('RESERVE_MC_SAMPLES', 50_000),
    alpha: num('RESERVE_ALPHA', 0.99),
  },
  oracle: {
    // in-house price service (xprices / pyth-pal). `api`-mode markets resolve
    // from `GET {baseUrl}/prices/{token}`.
    baseUrl: process.env.XPRICES_URL ?? 'https://xprices.umbralabs.io',
    // Per-request timeout (ms) when fetching a price.
    fetchTimeoutMs: num('ORACLE_FETCH_TIMEOUT_MS', 8_000),
    // A price whose `timestamp` is older than this (seconds) — or flagged `stale` —
    // is rejected as bad data (→ SUSPEND + alert), never used to resolve.
    maxStalenessSec: num('ORACLE_MAX_STALENESS_SEC', 300),
    // The cron scheduler's tick cadence (the resolver/auto-settle sweep).
    cron: process.env.ORACLE_CRON ?? '*/30 * * * * *', // every 30s
    // Master switch for the background scheduler (off in tests; they drive it directly).
    schedulerEnabled: (process.env.ORACLE_SCHEDULER ?? 'true') !== 'false',
  },
} as const;
