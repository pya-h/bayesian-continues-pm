// Market view — assemble the public-facing snapshot of a market: belief (μ, σ)
// pool NAV = cash − E_p[L(θ)], and LP share price. NAV uses the live belief and
// the MM's short book.

import { type BookEntry, GaussianBelief, expectedLiability } from '@bmm/core';
import { round8 } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { contracts } from '../db/schema.ts';
import { specFromRow } from '../lib/contract.ts';

export type MarketRow = typeof import('../db/schema.ts').markets.$inferSelect;

export interface MarketView {
  marketId: string;
  title: string;
  description: string | null;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
  status: string;
  creatorId: string;
  belief: { kind: 'gaussian'; mu: number; sigma: number; sigma2: number };
  cfg: Record<string, number | boolean>;
  cash: number;
  reserveRequired: number;
  pool: { nav: number; sharesTotal: number; sharePrice: number };
  thetaStar: number | null;
  opensAt: Date | null;
  closesAt: Date | null;
  resolvesAt: Date | null;
  createdAt: Date;
}

export async function loadBook(marketId: string): Promise<BookEntry[]> {
  const rows = await db.select().from(contracts).where(eq(contracts.marketId, marketId));
  return rows.map((r) => ({ spec: specFromRow(r.type, r.params), mmShort: r.mmShort }));
}

export async function buildMarketView(m: MarketRow): Promise<MarketView> {
  const belief = new GaussianBelief(m.currentMu, m.currentSigma * m.currentSigma);
  const book = await loadBook(m.marketId);
  const nav = round8(m.cash - expectedLiability(book, belief));
  const sharesTotal = m.lpSharesTotal;
  const sharePrice = sharesTotal > 0 ? round8(nav / sharesTotal) : 1;

  return {
    marketId: m.marketId,
    title: m.title,
    description: m.description,
    outcomeUnit: m.outcomeUnit,
    outcomeMin: m.outcomeMin,
    outcomeMax: m.outcomeMax,
    status: m.status,
    creatorId: m.creatorId,
    belief: { kind: 'gaussian', mu: m.currentMu, sigma: m.currentSigma, sigma2: belief.sigma2 },
    cfg: m.cfg,
    cash: m.cash,
    reserveRequired: m.reserveRequired,
    pool: { nav, sharesTotal, sharePrice },
    thetaStar: m.thetaStar,
    opensAt: m.opensAt,
    closesAt: m.closesAt,
    resolvesAt: m.resolvesAt,
    createdAt: m.createdAt,
  };
}
