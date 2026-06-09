import { Elysia } from 'elysia';
import { requireAuth } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { getUserTransactions } from '../services/ledgerView.ts';
import { portfolio, positionDetail } from '../services/statsSvc.ts';

export const userRoutes = new Elysia({ prefix: '/users' })
  .use(requireAuth)
  .get('/me/portfolio', async ({ user }) => {
    return { portfolio: await portfolio((user as UserRow).userId) };
  })
  .get('/me/positions/:contractId', async ({ params, user }) => {
    return { position: await positionDetail((user as UserRow).userId, params.contractId) };
  })
  .get('/me/transactions', async ({ user }) => {
    return await getUserTransactions((user as UserRow).userId);
  });
