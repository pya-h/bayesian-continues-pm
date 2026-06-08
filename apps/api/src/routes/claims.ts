import { Elysia } from 'elysia';
import { requireAuth } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { claimPayout } from '../services/settleSvc.ts';

export const claimRoutes = new Elysia({ prefix: '/markets' })
  .use(requireAuth)
  .post('/:id/claim', async ({ params, user }) => {
    const claim = await claimPayout(user as UserRow, params.id);
    return { claim };
  });
