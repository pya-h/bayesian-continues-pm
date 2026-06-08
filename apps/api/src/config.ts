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

export const config = {
  port: num('PORT', 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
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
} as const;
