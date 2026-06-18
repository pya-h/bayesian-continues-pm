// Reset the database to a clean slate: drop and recreate the app schema (and
// Drizzle's migration-tracking schema), so the next `db:migrate` rebuilds every
// table from `0000` up. Destructive — wipes ALL data. Dev/local only.
// Run via `bun run db:reset` (loads the root.env). Typical flow
// bun run db:reset && bun run db:migrate && bun run db:seed

import postgres from 'postgres';
import { parseDbUrl } from './url.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('❌ refusing to reset the database with NODE_ENV=production');
  process.exit(1);
}

const { url, schema } = parseDbUrl();
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  console.log(`⏳ resetting database (dropping schema "${schema}" + drizzle)…`);
  // CASCADE drops every table/index/fk in the schema in one shot; recreate it empty.
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  // Drizzle records applied migrations in its own schema — drop it so migrate re-runs all.
  await sql.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  console.log('✅ database reset — run `db:migrate` then `db:seed`');
} catch (err) {
  console.error('❌ reset failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
