// Thin repositories — small, typed query helpers over Drizzle. Kept intentionally
// minimal; more are added per feature phase. Services compose these + transactions.

import { addMoney } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { db } from './client.ts';
import { users } from './schema.ts';

export type UserRow = typeof users.$inferSelect;

export const userRepo = {
  async byUsername(username: string): Promise<UserRow | undefined> {
    const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return rows[0];
  },

  async byId(userId: string): Promise<UserRow | undefined> {
    const rows = await db.select().from(users).where(eq(users.userId, userId)).limit(1);
    return rows[0];
  },

  async create(input: {
    username: string;
    passwordHash: string;
    balance?: number;
  }): Promise<UserRow> {
    const rows = await db
      .insert(users)
      .values({
        username: input.username,
        passwordHash: input.passwordHash,
        balance: input.balance ?? 0,
      })
      .returning();
    return rows[0] as UserRow;
  },

  async credit(userId: string, amount: number): Promise<UserRow | undefined> {
    const u = await userRepo.byId(userId);
    if (!u) return undefined;
    if (u.isInfinite) return u;
    const rows = await db
      .update(users)
      .set({ balance: addMoney(u.balance, amount), updatedAt: new Date() })
      .where(eq(users.userId, userId))
      .returning();
    return rows[0];
  },
};
