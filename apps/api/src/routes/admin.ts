// Admin routes (role=admin only): list users, top up balances.

import { resolveDisputeSchema, setRoleSchema, topupSchema } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { requireAdmin } from '../auth/plugin.ts';
import { db } from '../db/client.ts';
import { type UserRow, userRepo } from '../db/repos.ts';
import { users } from '../db/schema.ts';
import { writeAudit } from '../lib/audit.ts';
import { publicUser } from '../lib/user.ts';
import { getAuditEvents } from '../services/auditView.ts';
import { listDisputes, resolveDispute } from '../services/disputeSvc.ts';
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
  // Grant/revoke a user's role (V2-3: mint `oracle` accounts that can be assigned
  // to centralized markets). Admins cannot demote themselves (avoid lockout).
  .patch('/users/:id/role', async ({ params, body, user, set }) => {
    const parsed = setRoleSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const target = await userRepo.byId(params.id);
    if (!target) {
      set.status = 404;
      return { error: 'User not found' };
    }
    if (target.userId === (user as UserRow).userId && parsed.data.role !== 'admin') {
      set.status = 400;
      return { error: 'Admins cannot change their own role' };
    }
    const upd = await db
      .update(users)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(eq(users.userId, target.userId))
      .returning();
    await writeAudit({
      actorId: (user as UserRow).userId,
      action: 'user_role_set',
      targetId: target.userId,
      payload: { from: target.role, to: parsed.data.role },
    });
    return { user: publicUser(upd[0] as UserRow) };
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
  })
  // V2-3 dispute queue. `?status=open` filters; default returns all, newest first.
  .get('/disputes', async ({ query }) => {
    const status = (query as { status?: string }).status as
      | 'open'
      | 'upheld'
      | 'rejected'
      | undefined;
    return { disputes: await listDisputes(status) };
  })
  // Close a dispute: uphold (override θ* + re-compute claims) or reject.
  .post('/disputes/:id/resolve', async ({ params, body, user, set }) => {
    const parsed = resolveDisputeSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    return { dispute: await resolveDispute(user as UserRow, params.id, parsed.data) };
  });
