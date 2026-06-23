// Oracle-panel routes — for `role=oracle` accounts (and admins) to resolve
// the `centralized`-mode markets assigned to them, once each market's deadline has
// passed. AuthZ is two-layered: `requireOracle` keeps non-oracles out of the panel
// `resolveCentralizedMarket` enforces per-market assignment + deadline.

import { oracleResolveSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { requireOracle } from '../auth/plugin.ts';
import type { UserRow } from '../db/repos.ts';
import { buildMarketView } from '../services/marketView.ts';
import { listOracleMarkets, resolveCentralizedMarket } from '../services/oracleSvc.ts';

export const oracleRoutes = new Elysia({ prefix: '/oracle' })
  .use(requireOracle)
  // Markets assigned to the caller that are past deadline and awaiting resolution.
  .get('/markets', async ({ user }) => {
    return { markets: await listOracleMarkets(user as UserRow) };
  })
  // Resolve an assigned centralized market with the reported outcome θ*.
  .post('/markets/:id/resolve', async ({ params, body, user, set }) => {
    const parsed = oracleResolveSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const m = await resolveCentralizedMarket(user as UserRow, params.id, parsed.data.thetaStar);
    return { market: await buildMarketView(m) };
  });
