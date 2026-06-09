// End-to-end demo script. Drives a *running*
// server over HTTP through the full v1 lifecycle and asserts the invariants
// admin creates + funds a market → tops up a user → user trades →
// admin resolves(θ*) + settles → user claims payout →
// portfolio shows final P&L → admin overview shows creator/MM P&L.
// Then it cleans up its own rows (FKs are RESTRICT → children first). Read-only
// to your other markets. Run against a live API
// PORT=4100 bun run --filter '@bmm/api' dev # in one shell
// API_URL=http://localhost:4100 bun run demo # in another
// Admin credentials come from the environment (ADMIN_USERNAME / ADMIN_PASSWORD)
// the password is never printed.

import { eq } from 'drizzle-orm';
import { db, sql } from '../db/client.ts';
import {
  auditEvents,
  beliefUpdates,
  claims,
  contracts,
  lpLedger,
  lpPositions,
  markets,
  oracles,
  positions,
  trades,
  transactions,
} from '../db/schema.ts';

const API = process.env.API_URL ?? 'http://localhost:4100';
const ADMIN_USER = process.env.ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD ?? '';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ''}`);
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

async function main(): Promise<void> {
  console.log(`\nBMM end-to-end demo → ${API}\n`);
  if (!ADMIN_PASS) throw new Error('ADMIN_PASSWORD must be set in the environment.');

  // 1. Admin logs in.
  const adminLogin = await call<{ token: string }>('POST', '/auth/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  check('admin login', adminLogin.status === 200);
  const admin = adminLogin.json.token;

  // 2. Create + open a funded market.
  const create = await call<{ market: { marketId: string } }>('POST', '/admin/markets', {
    token: admin,
    body: {
      title: '[DEMO-SCRIPT] BTC close',
      description: 'Throwaway market created by the demo script.',
      outcomeUnit: 'USD',
      initialMu: 100,
      initialSigma: 20,
      initialReserve: 20000,
    },
  });
  const marketId = create.json.market?.marketId;
  check('create market', create.status < 300 && !!marketId, marketId);
  await call('POST', `/admin/markets/${marketId}/open`, { token: admin });

  try {
    // 3. Top up alice and have her trade.
    const aliceLogin = await call<{ token: string; user: { userId: string } }>(
      'POST',
      '/auth/login',
      {
        body: { username: 'alice', password: 'password' },
      },
    );
    const alice = aliceLogin.json.token;
    const aliceId = aliceLogin.json.user.userId;
    await call('POST', `/admin/users/${aliceId}/topup`, { token: admin, body: { amount: 50000 } });

    const trade = await call<{
      fill: { filledQ: number; execPrice: number; beliefAfter: { mu: number } };
    }>('POST', `/markets/${marketId}/trade`, {
      token: alice,
      body: { spec: { type: 'CALL', strike: 100 }, q: 100 },
    });
    check('user trades a CALL', trade.status === 200 && trade.json.fill.filledQ > 0);
    check(
      'belief moved up on a bullish buy',
      trade.json.fill.beliefAfter.mu > 100,
      `μ=${trade.json.fill.beliefAfter.mu.toFixed(2)}`,
    );

    // 4. Resolve well in-the-money, then settle.
    const thetaStar = 130;
    const resolve = await call('POST', `/admin/markets/${marketId}/resolve`, {
      token: admin,
      body: { thetaStar },
    });
    check('admin resolves θ*=130', resolve.status === 200);
    const settle = await call('POST', `/admin/markets/${marketId}/settle`, { token: admin });
    check('admin settles', settle.status === 200);

    // 5. Alice claims. Payout = q · payoff(CALL@100, 130) = 100 · 30 = 3000.
    const claim = await call<{ claim: { credited: number; alreadyClaimed: boolean } }>(
      'POST',
      `/markets/${marketId}/claim`,
      { token: alice },
    );
    check(
      'claim pays 3000',
      Math.abs(claim.json.claim.credited - 3000) < 1e-6,
      `credited=${claim.json.claim.credited}`,
    );
    const claim2 = await call<{ claim: { credited: number } }>(
      'POST',
      `/markets/${marketId}/claim`,
      {
        token: alice,
      },
    );
    check('claim is idempotent (2nd credits 0)', Math.abs(claim2.json.claim.credited) < 1e-6);

    // 6. Portfolio shows the final P&L (settled, claimed).
    const pf = await call<{
      portfolio: {
        positions: {
          marketId: string;
          final: { payout: number; finalPnl: number; claimed: boolean } | null;
        }[];
      };
    }>('GET', '/users/me/portfolio', { token: alice });
    const demoPos = pf.json.portfolio.positions.find((p) => p.marketId === marketId);
    check(
      'portfolio shows final payout 3000',
      !!demoPos?.final && Math.abs(demoPos.final.payout - 3000) < 1e-6,
    );
    check(
      'portfolio marks it claimed',
      demoPos?.final?.claimed === true,
      `finalPnl=${demoPos?.final?.finalPnl.toFixed(2)}`,
    );

    // 7. Admin overview shows creator/MM P&L (zero-sum vs the trader).
    const overview = await call<{ overview: { mmPnl: number; volume: number; trades: number } }>(
      'GET',
      `/admin/markets/${marketId}/overview`,
      { token: admin },
    );
    check('admin overview has volume + trades', overview.json.overview.trades >= 1);
    check(
      'admin overview reports MM P&L',
      Number.isFinite(overview.json.overview.mmPnl),
      `mmPnl=${overview.json.overview.mmPnl.toFixed(2)}`,
    );
  } finally {
    // Clean up the demo market (children first — FKs are RESTRICT).
    if (marketId) {
      await db.delete(transactions).where(eq(transactions.marketId, marketId));
      await db.delete(claims).where(eq(claims.marketId, marketId));
      await db.delete(trades).where(eq(trades.marketId, marketId));
      await db.delete(positions).where(eq(positions.marketId, marketId));
      await db.delete(beliefUpdates).where(eq(beliefUpdates.marketId, marketId));
      await db.delete(contracts).where(eq(contracts.marketId, marketId));
      await db.delete(oracles).where(eq(oracles.marketId, marketId));
      await db.delete(lpLedger).where(eq(lpLedger.marketId, marketId));
      await db.delete(lpPositions).where(eq(lpPositions.marketId, marketId));
      await db.delete(auditEvents).where(eq(auditEvents.targetId, marketId));
      await db.delete(markets).where(eq(markets.marketId, marketId));
      console.log('\n  cleaned up demo market.');
    }
    await sql.end();
  }

  console.log(
    `\n${fail === 0 ? '✓ DEMO PASSED' : '✗ DEMO FAILED'} — ${pass} passed, ${fail} failed\n`,
  );
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nDemo errored:', e instanceof Error ? e.message : e);
  process.exit(1);
});
