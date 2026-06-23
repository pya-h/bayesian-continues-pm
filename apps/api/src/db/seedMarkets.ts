// Demo-market seed (multi-model refactor, G6 — the final step). Creates a handful
// of ready-to-use markets covering the full surface — one per model (Gaussian
// Student-t, Mixture, Gen·basis, Gen·exact) plus a bounded-outcome market that
// exercises the unbounded contracts — each opened with a few seeded trades so
// the charts and history look alive.
// Idempotent: a market is keyed by its (unique) title; if one already exists the
// whole market — creation AND its trades — is skipped, so re-running never
// duplicates or double-trades. Re-seed from scratch with
// bun run db:reset && bun run db:migrate && bun run db:seed && bun run db:seed:markets
// Drives the real service layer (createMarket → transitionMarket('open') →
// executeTrade), so seeded markets are byte-identical to user-created ones.

import type { ContractSpecDTO, CreateMarketDTO } from '@bmm/shared';
import { config } from '../config.ts';
import { createMarket, transitionMarket } from '../services/marketSvc.ts';
import { executeTrade } from '../services/tradeSvc.ts';
import { db, sql } from './client.ts';
import { type UserRow, userRepo } from './repos.ts';
import { markets } from './schema.ts';

interface SeedTrade {
  trader: 'alice' | 'bob';
  spec: ContractSpecDTO;
  q: number;
}
interface SeedMarket {
  dto: CreateMarketDTO;
  trades: SeedTrade[];
}

const DEMO_DEADLINE = new Date(Date.now() + 30 * 86_400_000).toISOString();

const SEED_MARKETS: SeedMarket[] = [
  // 0) API oracle — a crypto market that auto-resolves from the xprices BTC feed at
  // its deadline. θ* is BTC's price (kUSD). Centralized markets default
  // this one opts into the price-feed oracle.
  {
    dto: {
      title: 'Demo · BTC price @ deadline (API oracle)',
      description: 'Auto-resolves from the xprices BTC feed at the deadline. θ* = BTC price (USD).',
      outcomeUnit: 'USD',
      initialMu: 62_000,
      initialSigma: 8_000,
      initialReserve: 80_000,
      oracleMode: 'api',
      oracleToken: 'BTC',
      resolvesAt: DEMO_DEADLINE,
    },
    trades: [
      { trader: 'alice', spec: { type: 'BINARY_CALL', strike: 70_000 }, q: 40 },
      { trader: 'bob', spec: { type: 'CALL', strike: 60_000 }, q: 1 },
    ],
  },
  // 1) Gaussian — a plain price level.
  {
    dto: {
      title: 'Demo · BTC close (Gaussian)',
      description: 'Where does BTC settle? A plain Gaussian belief.',
      outcomeUnit: 'kUSD',
      initialMu: 95,
      initialSigma: 12,
      initialReserve: 50_000,
    },
    trades: [
      { trader: 'alice', spec: { type: 'CALL', strike: 100 }, q: 40 },
      { trader: 'bob', spec: { type: 'SPREAD', lower: 88, upper: 104 }, q: 120 },
      { trader: 'alice', spec: { type: 'BINARY_CALL', strike: 110 }, q: 80 },
    ],
  },
  // 2) Student-t — heavy tails (exact, the one capability the generals don't do).
  {
    dto: {
      title: 'Demo · Election margin (Student-t)',
      description: 'Vote margin with fat tails — Student-t (ν=4).',
      outcomeUnit: 'pts',
      initialMu: 3,
      initialSigma: 4,
      initialReserve: 40_000,
      belief: { kind: 'student_t', nu: 4 },
    },
    trades: [
      { trader: 'alice', spec: { type: 'BINARY_CALL', strike: 5 }, q: 100 },
      { trader: 'bob', spec: { type: 'TENT', center: 2, width: 6 }, q: 90 },
      // POLYNOMIAL degree 2 < ν=4 is allowed on a heavy tail (bounded outcome below).
    ],
  },
  // 3) Mixture — two explicit camps.
  {
    dto: {
      title: 'Demo · Fed decision (Mixture)',
      description: 'Two camps: a hold vs a cut. A fixed two-mode mixture.',
      outcomeUnit: 'bps',
      initialMu: -12,
      initialSigma: 16,
      initialReserve: 45_000,
      belief: {
        kind: 'mixture',
        components: [
          { pi: 0.6, mu: 0, sigma: 6 },
          { pi: 0.4, mu: -25, sigma: 8 },
        ],
      },
    },
    trades: [
      { trader: 'alice', spec: { type: 'GAUSSIAN', center: -25, width: 6 }, q: 70 },
      {
        trader: 'bob',
        spec: { type: 'SKEW_GAUSSIAN', center: 0, widthLeft: 4, widthRight: 10 },
        q: 60,
      },
    ],
  },
  // 4) Gen·basis — adaptive mixture; "paint the curve" with bell bets at distinct centers.
  {
    dto: {
      title: 'Demo · Startup valuation (Gen·basis)',
      description: 'Paint the belief: bell bets at different prices grow distinct camps.',
      outcomeUnit: 'MUSD',
      initialMu: 40,
      initialSigma: 14,
      initialReserve: 60_000,
      belief: { kind: 'gen_basis', bumps: [{ mu: 40, sigma: 14, weight: 1 }] },
    },
    trades: [
      { trader: 'alice', spec: { type: 'GAUSSIAN', center: 25, width: 6 }, q: 60 },
      { trader: 'bob', spec: { type: 'GAUSSIAN', center: 70, width: 7 }, q: 60 },
      { trader: 'alice', spec: { type: 'GAUSSIAN', center: 45, width: 6 }, q: 50 },
    ],
  },
  // 5) Gen·exact — max-entropy exp(−poly), a skewed unimodal shape.
  {
    dto: {
      title: 'Demo · Temp anomaly (Gen·exact)',
      description: 'A skewed max-entropy belief — exp(−poly) with λ₃≠0.',
      outcomeUnit: '°C',
      initialMu: 1.4,
      initialSigma: 0.6,
      initialReserve: 35_000,
      belief: { kind: 'gen_exact', lambdas: [1, 0.25, 0.1] },
    },
    trades: [
      { trader: 'alice', spec: { type: 'SIGMOID', center: 1.5, width: 0.3 }, q: 80 },
      { trader: 'bob', spec: { type: 'TRAPEZOID', lower: 1.0, upper: 1.8, width: 0.4 }, q: 90 },
    ],
  },
  // 6) Bounded-outcome Gaussian — showcases the unbounded contracts.
  {
    dto: {
      title: 'Demo · Approval rating (bounded, G5.2)',
      description: 'Bounded [0,100] — enables the unbounded Polynomial & Exponential contracts.',
      outcomeUnit: '%',
      outcomeMin: 0,
      outcomeMax: 100,
      initialMu: 52,
      initialSigma: 9,
      initialReserve: 200_000,
    },
    trades: [
      // (θ−52)² as a "distance / variance" bet: μ²−2μθ+θ².
      { trader: 'alice', spec: { type: 'POLYNOMIAL', coeffs: [52 * 52, -2 * 52, 1] }, q: 3 },
      { trader: 'bob', spec: { type: 'EXPONENTIAL', center: 52, rate: 0.06 }, q: 30 },
      { trader: 'alice', spec: { type: 'BINARY_CALL', strike: 55 }, q: 100 },
    ],
  },
];

async function mustUser(username: string): Promise<UserRow> {
  const u = await userRepo.byUsername(username);
  if (!u) throw new Error(`user "${username}" not found — run db:seed first`);
  return u;
}

try {
  const admin = await mustUser(config.admin.username);
  const traders: Record<'alice' | 'bob', UserRow> = {
    alice: await mustUser('alice'),
    bob: await mustUser('bob'),
  };
  const oracle = await mustUser('oracle');

  // centralized demo: a market the `oracle` account resolves manually after its
  // deadline (built at runtime since it needs the oracle user's id).
  const centralizedMarket: SeedMarket = {
    dto: {
      title: 'Demo · Cup final winner (Centralized oracle)',
      description: 'Resolved manually by the assigned oracle account after the deadline.',
      outcomeUnit: 'goals',
      initialMu: 2,
      initialSigma: 1.5,
      initialReserve: 30_000,
      oracleMode: 'centralized',
      oracleUserId: oracle.userId,
      resolvesAt: DEMO_DEADLINE,
    },
    trades: [{ trader: 'alice', spec: { type: 'BINARY_CALL', strike: 3 }, q: 60 }],
  };

  const existing = new Set(
    (await db.select({ title: markets.title }).from(markets)).map((r) => r.title),
  );

  let created = 0;
  let skipped = 0;
  for (const m of [...SEED_MARKETS, centralizedMarket]) {
    if (existing.has(m.dto.title)) {
      console.log(`   ↷ skip (exists): ${m.dto.title}`);
      skipped++;
      continue;
    }
    const market = await createMarket(admin, m.dto);
    await transitionMarket(admin, market.marketId, 'open');
    let fills = 0;
    for (const t of m.trades) {
      try {
        await executeTrade(traders[t.trader], market.marketId, { spec: t.spec, q: t.q });
        fills++;
      } catch (err) {
        console.warn(`   ⚠ trade skipped on "${m.dto.title}": ${(err as Error).message}`);
      }
    }
    console.log(`   ✓ ${m.dto.title} — opened, ${fills}/${m.trades.length} trades`);
    created++;
  }

  console.log(`✅ demo-market seed complete — ${created} created, ${skipped} skipped.`);
} catch (err) {
  console.error('❌ demo-market seed failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
