import { lpDepositSchema, lpWithdrawSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { requireAuth } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { claim, deposit, getLpView, withdraw } from '../services/lpSvc.ts';

export const lpRoutes = new Elysia({ prefix: '/markets' })
  .use(requireAuth)
  .get('/:id/lp', async ({ params, user }) => {
    return { lp: await getLpView(params.id, (user as UserRow).userId) };
  })
  .post('/:id/lp/deposit', async ({ params, body, user, set }) => {
    const parsed = lpDepositSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    return { deposit: await deposit(user as UserRow, params.id, parsed.data.amount) };
  })
  .post('/:id/lp/withdraw', async ({ params, body, user, set }) => {
    const parsed = lpWithdrawSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    return { withdraw: await withdraw(user as UserRow, params.id, parsed.data.shares) };
  })
  .post('/:id/lp/claim', async ({ params, user }) => {
    return { claim: await claim(user as UserRow, params.id) };
  });
