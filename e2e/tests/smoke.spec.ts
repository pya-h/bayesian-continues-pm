import { expect, test } from '@playwright/test';

// Web smoke. Drives the authenticated shell end-to-end in a real browser
// sign in → markets → open a market → see the live trade composer → portfolio.
// The full *transactional* cycle (trade → resolve → claim, with money moving and
// the zero-sum payout) is asserted headlessly and far more precisely by
// `bun run demo` and the api integration suite (apps/api/test/*.test.ts); this
// browser smoke proves the UI wires those flows together and renders.
// Prereq: a seeded DB (`bun run db:seed`) so `alice` / `password` can log in.

async function login(page: import('@playwright/test').Page, user: string, pass: string) {
  await page.goto('/');
  await page.getByPlaceholder('alice').fill(user);
  await page.getByPlaceholder('••••••').fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('sign in and reach the markets list', async ({ page }) => {
  await login(page, 'alice', 'password');
  await expect(page.getByRole('heading', { name: 'Markets' })).toBeVisible();
});

test('navigate to the portfolio', async ({ page }) => {
  await login(page, 'alice', 'password');
  await expect(page.getByRole('heading', { name: 'Markets' })).toBeVisible();
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
});

test('open a market and see the trade composer (if any market exists)', async ({ page }) => {
  await login(page, 'alice', 'password');
  await expect(page.getByRole('heading', { name: 'Markets' })).toBeVisible();

  // The markets grid renders cards as links with the market title as a heading.
  const firstCard = page.locator('a:has(h3)').first();
  const hasMarket = (await firstCard.count()) > 0;
  test.skip(!hasMarket, 'no markets seeded — create one via the admin panel or `bun run demo`');

  await firstCard.click();
  // The trade page shows the belief/consensus and a Buy control on the composer.
  await expect(page.getByText(/consensus|belief|liquidity/i).first()).toBeVisible();
});
