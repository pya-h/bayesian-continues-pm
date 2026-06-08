import { defineConfig } from 'drizzle-kit';

// `generate` doesn't connect, so tolerate a missing env there; `migrate`/`studio`
// are run via `bun --env-file=../../.env`, which provides DATABASE_URL.
function driverUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'postgresql://localhost:5432/placeholder';
  const u = new URL(raw);
  u.searchParams.delete('schema');
  return u.toString();
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: driverUrl() },
});
