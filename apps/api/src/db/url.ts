// DATABASE_URL parsing. Strips the Prisma-style `?schema=public` query param
// (postgres.js/Drizzle reject it) and returns the schema name separately so the
// connection can set its search_path.

export interface ParsedDbUrl {
  url: string; // driver-safe URL (no `schema` query param)
  schema: string; // search_path schema (default 'public')
}

export function parseDbUrl(raw: string | undefined = process.env.DATABASE_URL): ParsedDbUrl {
  if (!raw) throw new Error('DATABASE_URL is not set');
  const u = new URL(raw);
  const schema = u.searchParams.get('schema') ?? 'public';
  u.searchParams.delete('schema');
  return { url: u.toString(), schema };
}
