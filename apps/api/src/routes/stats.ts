import { Elysia } from 'elysia';
import { marketHistory, marketStats } from '../services/statsSvc.ts';

export const statsRoutes = new Elysia({ prefix: '/markets' })
  .get('/:id/stats', async ({ params }) => {
    // Trader-facing subset (admin-only aggregates live at /admin/markets/:id/overview).
    const s = await marketStats(params.id);
    return {
      stats: {
        marketId: s.marketId,
        status: s.status,
        belief: s.belief,
        impliedPrice: s.impliedPrice,
        volume: s.volume,
        trades: s.trades,
        traders: s.traders,
        nav: s.nav,
        beliefDrift: s.beliefDrift,
        calibration: s.calibration,
      },
    };
  })
  .get('/:id/history', async ({ params, query }) => {
    const contractKey = typeof query.contractKey === 'string' ? query.contractKey : undefined;
    return { history: await marketHistory(params.id, contractKey) };
  });
