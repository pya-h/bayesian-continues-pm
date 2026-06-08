// DB client — postgres.js connection + Drizzle. Connection is lazy (postgres.js
// does not dial until the first query), so importing this does not require a live
// DB (the API can serve /health without one). search_path is set from the
// `?schema=` param if present.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.ts';
import { parseDbUrl } from './url.ts';

const { url, schema: searchPath } = parseDbUrl();

export const sql = postgres(url, {
  max: 10,
  connection: { search_path: searchPath },
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });

export { schema };
export type Db = typeof db;
