import { Elysia } from 'elysia';
import { marketRepo } from '../db/repos.ts';
import { buildMarketView } from '../services/marketView.ts';

export const marketRoutes = new Elysia({ prefix: '/markets' })
  .get('/', async () => {
    const rows = await marketRepo.list();
    const markets = await Promise.all(rows.map(buildMarketView));
    return { markets };
  })
  .get('/:id', async ({ params, set }) => {
    const m = await marketRepo.byId(params.id);
    if (!m) {
      set.status = 404;
      return { error: 'Market not found' };
    }
    return { market: await buildMarketView(m) };
  });
