// Dispute routes. User-facing: a position holder files a dispute against a
// RESOLVED market within its window. Admin queue + resolution live under /admin
// . Filing is gated to authenticated holders; the service
// enforces holder-status, window, and one-open-per-user.

import { disputeSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { requireAuth } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { fileDispute } from '../services/disputeSvc.ts';

export const disputeRoutes = new Elysia({ prefix: '/markets' })
  .use(requireAuth)
  .post('/:id/dispute', async ({ params, body, user, set }) => {
    const parsed = disputeSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const dispute = await fileDispute(user as UserRow, params.id, parsed.data);
    set.status = 201;
    return { dispute };
  });
