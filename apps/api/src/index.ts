import { CORE_VERSION } from '@bmm/core';
import { SHARED_VERSION } from '@bmm/shared';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { Elysia } from 'elysia';
import { config } from './config.ts';

export const app = new Elysia()
  .use(cors({ origin: config.webOrigin, credentials: true }))
  .use(
    swagger({
      documentation: {
        info: { title: 'BMM API', version: '0.1.0' },
      },
    }),
  )
  .get('/health', () => ({
    status: 'ok',
    service: 'bmm-api',
    versions: { api: '0.1.0', core: CORE_VERSION, shared: SHARED_VERSION },
    time: new Date().toISOString(),
  }));

// Only listen when run directly (not when imported by tests).
if (import.meta.main) {
  app.listen(config.port);
  console.log(`🟢 BMM API on http://localhost:${config.port}  (docs: /swagger)`);
}

export type App = typeof app;
