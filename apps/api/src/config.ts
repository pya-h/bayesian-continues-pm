function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be a number, got "${v}"`);
  return n;
}

export const config = {
  port: num('PORT', 3000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://bmm:bmm@localhost:5432/bmm',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    // password is only strictly required when seeding; tolerate absence at boot.
    password: process.env.ADMIN_PASSWORD ?? '',
  },
  reserve: {
    mcSamples: num('RESERVE_MC_SAMPLES', 50_000),
    alpha: num('RESERVE_ALPHA', 0.99),
  },
} as const;

export { required };
