// Test preload guard (wired via apps/api/bunfig.toml → [test].preload).
// The API suite is an INTEGRATION suite: every file connects to the real Postgres
// DB and logs in as the admin user. Previously each file self-gated on
// `describe.if(hasEnv)` and the runner passed `--pass-with-no-tests`, so a run with
// a missing/incomplete.env would silently register ZERO tests and report green.
// This preload runs once per (isolated) test process BEFORE any test file loads and
// fails fast with a clear message if the required env is absent — a misconfigured
// run can no longer masquerade as passing. Env is loaded.env via the
// `--env-file=../../.env` flag on the `test` script.

const REQUIRED = ['DATABASE_URL', 'ADMIN_PASSWORD'] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length > 0) {
  const verb = missing.length === 1 ? 'is' : 'are';
  throw new Error(
    `API integration tests require ${REQUIRED.join(' and ')} to be set, but ${missing.join(', ')} ${verb} missing. These come from .env (loaded via the --env-file flag). Set DATABASE_URL (Postgres connection) and ADMIN_PASSWORD, then re-run.`,
  );
}
