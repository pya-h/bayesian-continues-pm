// MarketSvc — create markets and drive their lifecycle.
// Create: resolve the engine config from (μ₀, σ₀) + overrides, seed cash = R₀
// mint the creator's LP shares (= R₀, genesis share price 1) + ledger entry — all
// in one transaction. Lifecycle: a validated state machine; each transition runs
// under the per-market lock with `FOR UPDATE` on the market row, then emits a
// `market_status` WS event. Oracle (manual θ*) is recorded on resolve.

import { type EngineConfig, makeEngineConfig } from '@bmm/core';
import type { CreateMarketDTO, MarketStatus } from '@bmm/shared';
import { subMoney } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type MarketRow, type UserRow, marketRepo } from '../db/repos.ts';
import { lpLedger, lpPositions, markets, oracles, users } from '../db/schema.ts';
import { writeAudit } from '../lib/audit.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';
import { withMarketLock } from './marketQueue.ts';
import { recordClaims, refundPositions } from './settleSvc.ts';

type LifecycleAction = 'open' | 'suspend' | 'resume' | 'resolve' | 'settle' | 'cancel' | 'close';

const ACTIONS: Record<LifecycleAction, { from: MarketStatus[]; to: MarketStatus }> = {
  open: { from: ['CREATED', 'SUSPENDED'], to: 'OPEN' },
  suspend: { from: ['OPEN'], to: 'SUSPENDED' },
  resume: { from: ['SUSPENDED'], to: 'OPEN' },
  resolve: { from: ['OPEN', 'SUSPENDED'], to: 'RESOLVED' },
  settle: { from: ['RESOLVED'], to: 'SETTLED' },
  cancel: { from: ['CREATED', 'OPEN', 'SUSPENDED'], to: 'CANCELLED' },
  close: { from: ['SETTLED'], to: 'CLOSED' },
};

function toDate(s: string | undefined): Date | null {
  return s ? new Date(s) : null;
}

export async function createMarket(creator: UserRow, dto: CreateMarketDTO): Promise<MarketRow> {
  const cfg: EngineConfig = makeEngineConfig(dto.initialMu, dto.initialSigma, dto.cfg ?? {});
  const reserve = dto.initialReserve;

  const market = await db.transaction(async (tx) => {
    // Non-infinite creators fund the reserve from their balance.
    if (!creator.isInfinite) {
      if (creator.balance < reserve) {
        throw new HttpError(400, 'Insufficient balance to fund the initial reserve');
      }
      await tx
        .update(users)
        .set({ balance: subMoney(creator.balance, reserve), updatedAt: new Date() })
        .where(eq(users.userId, creator.userId));
    }

    const inserted = await tx
      .insert(markets)
      .values({
        title: dto.title,
        description: dto.description ?? null,
        outcomeUnit: dto.outcomeUnit,
        outcomeMin: dto.outcomeMin ?? null,
        outcomeMax: dto.outcomeMax ?? null,
        status: 'CREATED',
        creatorId: creator.userId,
        beliefKind: 'gaussian',
        initialMu: dto.initialMu,
        initialSigma: dto.initialSigma,
        currentMu: dto.initialMu,
        currentSigma: dto.initialSigma,
        cfg: cfg as unknown as Record<string, number | boolean>,
        cash: reserve,
        reserveRequired: 0,
        lpSharesTotal: reserve,
        opensAt: toDate(dto.opensAt),
        closesAt: toDate(dto.closesAt),
        resolvesAt: toDate(dto.resolvesAt),
      })
      .returning();
    const m = inserted[0] as MarketRow;

    // Mint the creator's genesis LP shares (= R₀, share price 1).
    await tx.insert(lpPositions).values({
      marketId: m.marketId,
      userId: creator.userId,
      shares: reserve,
      totalDeposited: reserve,
    });
    await tx.insert(lpLedger).values({
      marketId: m.marketId,
      userId: creator.userId,
      kind: 'deposit',
      amount: reserve,
      sharesDelta: reserve,
      navBefore: 0,
      sharePrice: 1,
    });

    return m;
  });

  await writeAudit({
    actorId: creator.userId,
    action: 'market_create',
    targetId: market.marketId,
    payload: {
      title: dto.title,
      initialReserve: reserve,
      mu: dto.initialMu,
      sigma: dto.initialSigma,
    },
  });

  return market;
}

export async function transitionMarket(
  actor: UserRow,
  marketId: string,
  action: LifecycleAction,
  opts: { thetaStar?: number; oracleSource?: string } = {},
): Promise<MarketRow> {
  const rule = ACTIONS[action];

  const updated = await withMarketLock(marketId, () =>
    db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, marketId))
        .for('update');
      const m = rows[0] as MarketRow | undefined;
      if (!m) throw new HttpError(404, 'Market not found');
      if (!rule.from.includes(m.status as MarketStatus)) {
        throw new HttpError(409, `Cannot ${action} a ${m.status} market`);
      }

      const patch: Partial<MarketRow> = { status: rule.to, updatedAt: new Date() };
      if (action === 'resolve') {
        if (opts.thetaStar == null || !Number.isFinite(opts.thetaStar)) {
          throw new HttpError(400, 'resolve requires a finite thetaStar');
        }
        patch.thetaStar = opts.thetaStar;
        await tx.insert(oracles).values({
          marketId,
          source: opts.oracleSource ?? 'manual_admin',
          resolvedValue: opts.thetaStar,
          confidence: 1,
        });
        // Compute every open position's payout into uncredited `claims` rows.
        await recordClaims(tx, marketId, opts.thetaStar);
      }
      if (action === 'cancel') {
        // Unwind: refund traders' open cost basis and shrink MM cash to match.
        const refunded = await refundPositions(tx, marketId);
        patch.cash = subMoney(m.cash, refunded);
      }
      if (action === 'open' && m.status === 'CREATED' && !m.opensAt) {
        patch.opensAt = new Date();
      }

      const res = await tx
        .update(markets)
        .set(patch)
        .where(eq(markets.marketId, marketId))
        .returning();
      return res[0] as MarketRow;
    }),
  );

  await writeAudit({
    actorId: actor.userId,
    action: `market_${action}`,
    targetId: marketId,
    payload: action === 'resolve' ? { thetaStar: opts.thetaStar } : {},
  });
  publish(topics.market(marketId), { type: 'market_status', status: updated.status });
  return updated;
}

export { marketRepo };
