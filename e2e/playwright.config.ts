import { defineConfig, devices } from '@playwright/test';

// Playwright config for the BMM web smoke. Boots the API on a free port (4100 —
// host ports ≤4000 are occupied here) and the Vite dev server pointed at it, then
// runs the browser tests against the web app. Requires a reachable Postgres (the
// same DATABASE_URL the API uses) and a seeded admin/alice (`bun run db:seed`).
// cd e2e && bun install && bun run install:browsers
// bun run e2e
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // API on 4100, run from the repo root.
      command: 'PORT=4100 bun --env-file=.env apps/api/src/index.ts',
      cwd: '..',
      url: 'http://localhost:4100/markets',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Vite dev server, pointed at the API above.
      command:
        'VITE_API_URL=http://localhost:4100 VITE_WS_URL=ws://localhost:4100/ws bun run --filter @bmm/web dev',
      cwd: '..',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
