// Seed: upsert the admin user (from env) + a couple of demo users. Idempotent.
// Run via `bun run db:seed`.

import { eq } from 'drizzle-orm';
import { config } from '../config.ts';
import { db, sql } from './client.ts';
import { users } from './schema.ts';

async function upsertUser(opts: {
  username: string;
  password: string;
  role: 'user' | 'admin';
  isInfinite: boolean;
  balance: number;
  tier: 'new' | 'verified' | 'advanced' | 'institutional';
}) {
  const passwordHash = await Bun.password.hash(opts.password);
  await db
    .insert(users)
    .values({
      username: opts.username,
      passwordHash,
      role: opts.role,
      isInfinite: opts.isInfinite,
      balance: opts.balance,
      tier: opts.tier,
    })
    .onConflictDoUpdate({
      target: users.username,
      // keep role/infinite/tier authoritative; refresh password; don't clobber balance
      set: { role: opts.role, isInfinite: opts.isInfinite, tier: opts.tier, updatedAt: new Date() },
    });
}

try {
  if (!config.admin.password) {
    throw new Error('ADMIN_PASSWORD is not set — refusing to seed an admin with an empty password');
  }

  await upsertUser({
    username: config.admin.username,
    password: config.admin.password,
    role: 'admin',
    isInfinite: true,
    balance: 0,
    tier: 'institutional',
  });

  // Demo traders with a starter balance (admin can top up more).
  for (const username of ['alice', 'bob']) {
    await upsertUser({
      username,
      password: 'password',
      role: 'user',
      isInfinite: false,
      balance: 10_000,
      tier: 'verified',
    });
  }

  const all = await db
    .select({ username: users.username, role: users.role, balance: users.balance })
    .from(users)
    .orderBy(users.createdAt);
  console.log('✅ seed complete. users:');
  for (const u of all) console.log(`   - ${u.username} (${u.role}) balance=${u.balance}`);
  // sanity: admin exists & is infinite
  const admin = await db.select().from(users).where(eq(users.username, config.admin.username));
  console.log(`   admin infinite=${admin[0]?.isInfinite}`);
} catch (err) {
  console.error('❌ seed failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
