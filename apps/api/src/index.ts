import { CORE_VERSION } from '@bmm/core';
import { SHARED_VERSION } from '@bmm/shared';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { Elysia } from 'elysia';
import { authPlugin } from './auth/plugin.ts';
import { config } from './config.ts';
import { HttpError } from './lib/errors.ts';
import { setServer } from './realtime.ts';
import { adminRoutes } from './routes/admin.ts';
import { adminMarketRoutes } from './routes/adminMarkets.ts';
import { authRoutes } from './routes/auth.ts';
import { claimRoutes } from './routes/claims.ts';
import { marketRoutes } from './routes/markets.ts';
import { tradeRoutes } from './routes/trades.ts';
import { wsRoutes } from './ws.ts';

export const app = new Elysia()
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.message };
    }
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not found' };
    }
    if (code === 'VALIDATION') {
      set.status = 400;
      return { error: 'Validation failed', detail: (error as Error).message };
    }
    const status = typeof set.status === 'number' && set.status >= 400 ? set.status : 500;
    set.status = status;
    if (status >= 500) console.error(`[error] ${code}:`, (error as Error).message);
    return { error: (error as Error).message ?? 'Internal error' };
  })
  .onRequest(({ request }) => {
    const url = new URL(request.url);
    if (url.pathname !== '/health') console.log(`→ ${request.method} ${url.pathname}`);
  })
  .use(cors({ origin: config.webOrigin, credentials: true }))
  .use(
    swagger({
      path: '/swagger',
      documentation: { info: { title: 'BMM API', version: '0.1.0' } },
    }),
  )
  .use(authPlugin)
  .get('/health', () => ({
    status: 'ok',
    service: 'bmm-api',
    versions: { api: '0.1.0', core: CORE_VERSION, shared: SHARED_VERSION },
    time: new Date().toISOString(),
  }))
  .use(authRoutes)
  .use(marketRoutes)
  .use(tradeRoutes)
  .use(claimRoutes)
  .use(adminRoutes)
  .use(adminMarketRoutes)
  .use(wsRoutes);

if (import.meta.main) {
  app.listen(config.port);
  setServer(app.server as unknown as { publish(topic: string, data: string): void });
  console.log(`🟢 BMM API on http://localhost:${config.port}  (docs: /swagger)`);
}

export type App = typeof app;
