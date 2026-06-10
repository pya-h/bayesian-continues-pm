import { quoteSchema, tradeSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { requireAuth } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { executeTrade, quote, sellAllPositions } from '../services/tradeSvc.ts';

export const tradeRoutes = new Elysia({ prefix: '/markets' })
  .use(requireAuth)
  .post('/:id/quote', async ({ params, body, set }) => {
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    return { quote: await quote(params.id, parsed.data) };
  })
  .post('/:id/trade', async ({ params, body, user, set }) => {
    const parsed = tradeSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const fill = await executeTrade(user as UserRow, params.id, parsed.data);
    return { fill };
  })
  .post('/:id/sell-all', async ({ params, user }) => {
    const result = await sellAllPositions(user as UserRow, params.id);
    return { result };
  });
