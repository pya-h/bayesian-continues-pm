// Market view — assemble the public-facing snapshot of a market: belief (μ, σ)
// pool NAV = cash − E_p[L(θ)], and LP share price. NAV uses the live belief and
// the MM's short book.

import {
  type BookEntry,
  GenExactBelief,
  MixtureBelief,
  StudentTBelief,
  expectedLiability,
} from '@bmm/core';
import { type ModelTag, type OracleMode, round8 } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { contracts } from '../db/schema.ts';
import { loadBelief } from '../lib/belief.ts';
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
  model: ModelTag;
  belief: {
    kind: 'gaussian' | 'mixture' | 'student_t' | 'gen_exact';
    mu: number;
    sigma: number;
    sigma2: number;
    // Present for mixture markets: per-component weight/mean/σ for the multi-bump chart.
    components?: { pi: number; mu: number; sigma: number }[];
    // Present for Student-t markets: degrees of freedom ν, so the chart can draw fat tails.
    nu?: number;
    // Present for Gen·exact markets: the exponent shape [λ₂, λ₃, λ₄].
    lambdas?: [number, number, number];
    // Gen·exact location μ / scale σ params (≠ the summary mean/σ for skewed shapes).
    loc?: number;
    scale?: number;
  };
  cfg: Record<string, number | boolean>;
  cash: number;
  reserveRequired: number;
  pool: { nav: number; sharesTotal: number; sharePrice: number };
  thetaStar: number | null;
  oracleMode: OracleMode;
  oracleUserId: string | null;
  oracleToken: string | null;
  // When θ* was set (opens the dispute window); null until resolved.
  resolvedAt: Date | null;
  disputeWindowSec: number;
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
  const belief = loadBelief(m);
  const book = await loadBook(m.marketId);
  const nav = round8(m.cash - expectedLiability(book, belief));
  const sharesTotal = m.lpSharesTotal;
  const sharePrice = sharesTotal > 0 ? round8(nav / sharesTotal) : 1;

  const components =
    belief instanceof MixtureBelief
      ? belief.components.map((c) => ({
          pi: round8(c.pi),
          mu: round8(c.mu),
          sigma: round8(Math.sqrt(c.sigma2)),
        }))
      : undefined;

  // Gen·exact carries its exponent shape + raw location/scale (distinct from the
  // summary mean/σ) so the chart can draw the true exp(−poly) curve.
  const genExact =
    belief instanceof GenExactBelief
      ? {
          lambdas: [...belief.lambdas] as [number, number, number],
          loc: round8(belief.mu),
          scale: round8(belief.sigma),
        }
      : undefined;

  return {
    marketId: m.marketId,
    title: m.title,
    description: m.description,
    outcomeUnit: m.outcomeUnit,
    outcomeMin: m.outcomeMin,
    outcomeMax: m.outcomeMax,
    status: m.status,
    creatorId: m.creatorId,
    model: m.model,
    belief: {
      kind: belief.kind,
      mu: round8(belief.mean()),
      sigma: round8(belief.stddev()),
      sigma2: round8(belief.variance()),
      components,
      nu: belief instanceof StudentTBelief ? belief.nu : undefined,
      lambdas: genExact?.lambdas,
      loc: genExact?.loc,
      scale: genExact?.scale,
    },
    cfg: m.cfg,
    cash: m.cash,
    reserveRequired: m.reserveRequired,
    pool: { nav, sharesTotal, sharePrice },
    thetaStar: m.thetaStar,
    oracleMode: m.oracleMode,
    oracleUserId: m.oracleUserId,
    oracleToken: m.oracleToken,
    resolvedAt: m.resolvedAt,
    disputeWindowSec: m.disputeWindowSec,
    opensAt: m.opensAt,
    closesAt: m.closesAt,
    resolvesAt: m.resolvesAt,
    createdAt: m.createdAt,
  };
}
