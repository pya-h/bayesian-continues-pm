// Admin routes (role=admin only): list users, top up balances.

import { topupSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { requireAdmin } from '../auth/plugin.ts';
import { db } from '../db/client.ts';
import { userRepo } from '../db/repos.ts';
import { users } from '../db/schema.ts';
import { publicUser } from '../lib/user.ts';
import { getAuditEvents } from '../services/auditView.ts';
import { adminTopup } from '../services/fundingSvc.ts';
import { getUserTransactions } from '../services/ledgerView.ts';

export const adminRoutes = new Elysia({ prefix: '/admin' })
  .use(requireAdmin)
  .get('/users', async () => {
    const rows = await db
      .select({
        userId: users.userId,
        username: users.username,
        role: users.role,
        balance: users.balance,
        isInfinite: users.isInfinite,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.createdAt);
    return { users: rows };
  })
  .post('/users/:id/topup', async ({ params, body, user, set }) => {
    const parsed = topupSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const target = await userRepo.byId(params.id);
    if (!target) {
      set.status = 404;
      return { error: 'User not found' };
    }
    const admin = user?.userId ? await userRepo.byId(user.userId) : undefined;
    if (!admin) {
      set.status = 401;
      return { error: 'Admin not found' };
    }
    // adminTopup writes its own audit row inside the credit transaction.
    const { user: updated } = await adminTopup(admin, target, parsed.data.amount);
    return { user: publicUser(updated) };
  })
  // A specific user's full transaction history (admin-only mirror of
  // `/users/me/transactions`) — surfaced in the admin Users tab.
  .get('/users/:id/transactions', async ({ params, set }) => {
    const target = await userRepo.byId(params.id);
    if (!target) {
      set.status = 404;
      return { error: 'User not found' };
    }
    return await getUserTransactions(target.userId);
  })
  // The append-only audit log (admin top-ups, market lifecycle, trades), newest
  // first, joined to actor + target names. Read-only viewer over `audit_events`.
  .get('/audit', async () => {
    return { events: await getAuditEvents() };
  });
