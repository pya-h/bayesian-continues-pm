// Apply pending Drizzle migrations, then exit. Run via `bun run db:migrate`
// (which loads the root.env). Idempotent.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { parseDbUrl } from './url.ts';

const { url, schema: searchPath } = parseDbUrl();
const sql = postgres(url, { max: 1, connection: { search_path: searchPath }, onnotice: () => {} });

try {
  console.log('⏳ running migrations…');
  await migrate(drizzle(sql), { migrationsFolder: `${import.meta.dir}/../../drizzle` });
  console.log('✅ migrations applied');
} catch (err) {
  console.error('❌ migration failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
