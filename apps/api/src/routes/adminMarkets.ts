import { createMarketSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { requireAdmin } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { getMarketLedger } from '../services/marketLedgerSvc.ts';
import { createMarket, transitionMarket } from '../services/marketSvc.ts';
import { buildMarketView } from '../services/marketView.ts';
import { marketStats } from '../services/statsSvc.ts';

export const adminMarketRoutes = new Elysia({ prefix: '/admin/markets' })
  .use(requireAdmin)
  .post('/', async ({ body, user, set }) => {
    const parsed = createMarketSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const m = await createMarket(user as UserRow, parsed.data);
    set.status = 201;
    return { market: await buildMarketView(m) };
  })
  .post('/:id/open', async ({ params, user }) => {
    const m = await transitionMarket(user as UserRow, params.id, 'open');
    return { market: await buildMarketView(m) };
  })
  .post('/:id/suspend', async ({ params, user }) => {
    const m = await transitionMarket(user as UserRow, params.id, 'suspend');
    return { market: await buildMarketView(m) };
  })
  .post('/:id/resume', async ({ params, user }) => {
    const m = await transitionMarket(user as UserRow, params.id, 'resume');
    return { market: await buildMarketView(m) };
  })
  .post('/:id/resolve', async ({ params, body, user, set }) => {
    const thetaStar = (body as { thetaStar?: unknown })?.thetaStar;
    if (typeof thetaStar !== 'number' || !Number.isFinite(thetaStar)) {
      set.status = 400;
      return { error: 'resolve requires a numeric thetaStar' };
    }
    const m = await transitionMarket(user as UserRow, params.id, 'resolve', { thetaStar });
    return { market: await buildMarketView(m) };
  })
  .post('/:id/settle', async ({ params, user }) => {
    const m = await transitionMarket(user as UserRow, params.id, 'settle');
    return { market: await buildMarketView(m) };
  })
  .post('/:id/cancel', async ({ params, user }) => {
    const m = await transitionMarket(user as UserRow, params.id, 'cancel');
    return { market: await buildMarketView(m) };
  })
  .post('/:id/close', async ({ params, user }) => {
    const m = await transitionMarket(user as UserRow, params.id, 'close');
    return { market: await buildMarketView(m) };
  })
  .get('/:id/overview', async ({ params }) => {
    return { overview: await marketStats(params.id) };
  })
  .get('/:id/ledger', async ({ params }) => {
    return { ledger: await getMarketLedger(params.id) };
  });
