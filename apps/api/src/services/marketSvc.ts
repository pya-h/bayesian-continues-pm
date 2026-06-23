// MarketSvc — create markets and drive their lifecycle.
// Create: resolve the engine config from (μ₀, σ₀) + overrides, seed cash = R₀
// mint the creator's LP shares (= R₀, genesis share price 1) + ledger entry — all
// in one transaction. Lifecycle: a validated state machine; each transition runs
// under the per-market lock with `FOR UPDATE` on the market row, then emits a
// `market_status` WS event. Oracle (manual θ*) is recorded on resolve.

import {
  type BeliefModel,
  type EngineConfig,
  GaussianBelief,
  GenExactBelief,
  MixtureBelief,
  StudentTBelief,
  makeEngineConfig,
} from '@bmm/core';
import type { CreateMarketDTO, MarketStatus, ModelTag } from '@bmm/shared';
import { OracleMode, TransactionKind, UserRole, addMoney, round8, subMoney } from '@bmm/shared';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type MarketRow, type UserRow, marketRepo } from '../db/repos.ts';
import { lpLedger, lpPositions, markets, oracles, users } from '../db/schema.ts';
import { writeAudit } from '../lib/audit.ts';
import { beliefPersistFields } from '../lib/belief.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';
import { recordTx } from './ledgerSvc.ts';
import { lpClaimAmount, lpSharePrice } from './lpMath.ts';
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

function makeInitialBelief(dto: CreateMarketDTO): BeliefModel {
  const variance = dto.initialSigma * dto.initialSigma;
  switch (dto.belief?.kind) {
    case 'mixture':
      return new MixtureBelief(
        dto.belief.components.map((c) => ({ pi: c.pi, mu: c.mu, sigma2: c.sigma * c.sigma })),
      );
    case 'student_t':
      // σ is the desired stddev; fromVariance converts to the t's scale² via ν/(ν−2).
      return StudentTBelief.fromVariance(dto.belief.nu, dto.initialMu, variance);
    case 'gen_basis':
      // Gen·basis IS an adaptive Gaussian mixture — the authored bumps seed it; the
      // 'gen_basis' identity (spawning update, relaxed caps) rides on the `model`
      // tag (resolveModel), while belief_kind stays 'mixture'. σ → σ².
      return new MixtureBelief(
        dto.belief.bumps.map((b) => ({ pi: b.weight, mu: b.mu, sigma2: b.sigma * b.sigma })),
      );
    case 'gen_exact':
      // Gen·exact — max-entropy exp(−poly). Reuses initialMu/initialSigma as the
      // location μ / scale σ (like student_t), authoring only the exponent shape λ.
      return new GenExactBelief(dto.initialMu, dto.initialSigma, dto.belief.lambdas);
    default:
      return new GaussianBelief(dto.initialMu, variance);
  }
}

// The creator-chosen model tag persisted in `markets.model`. Equals the authored
// belief kind (which doubles as the tag for every model), defaulting to Gaussian.
// Distinct from belief_kind: 'gen_basis' here ⇒ belief_kind 'mixture'.
function resolveModel(dto: CreateMarketDTO): ModelTag {
  return dto.belief?.kind ?? 'gaussian';
}

// Validate + normalize the oracle assignment from the create DTO. `api` mode
// requires a token (schema-enforced) and ignores any oracleUserId; `centralized`
// mode may name a `role=oracle`/admin account that will resolve it (null ⇒ admin
// only); `decentralized` is accepted as a placeholder but cannot resolve yet.
async function resolveOracleAssignment(dto: CreateMarketDTO): Promise<{
  oracleMode: OracleMode;
  oracleUserId: string | null;
  oracleToken: string | null;
  disputeWindowSec: number;
}> {
  const oracleMode: OracleMode = dto.oracleMode ?? OracleMode.CENTRALIZED;
  const disputeWindowSec = dto.disputeWindowSec ?? 86400;

  if (oracleMode === OracleMode.API) {
    if (!dto.oracleToken) throw new HttpError(400, 'oracleToken is required for api oracle mode');
    return { oracleMode, oracleUserId: null, oracleToken: dto.oracleToken, disputeWindowSec };
  }

  let oracleUserId: string | null = null;
  if (oracleMode === OracleMode.CENTRALIZED && dto.oracleUserId) {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.userId, dto.oracleUserId));
    const u = rows[0];
    if (!u) throw new HttpError(400, 'Assigned oracle user not found');
    if (u.role !== UserRole.ORACLE && u.role !== UserRole.ADMIN) {
      throw new HttpError(400, 'Assigned oracle must have the oracle (or admin) role');
    }
    oracleUserId = dto.oracleUserId;
  }
  return { oracleMode, oracleUserId, oracleToken: null, disputeWindowSec };
}

export async function createMarket(creator: UserRow, dto: CreateMarketDTO): Promise<MarketRow> {
  const cfg: EngineConfig = makeEngineConfig(dto.initialMu, dto.initialSigma, dto.cfg ?? {});
  const reserve = dto.initialReserve;

  // Initial belief by authored kind, else Gaussian (v1). The cfg reference scale is
  // seeded from the *authored* μ/σ (above), but the persisted initialMu/initialSigma
  // columns store the genesis belief SUMMARY (mean/σ) — for a mixture that is Σπμ and
  // the total σ, NOT the authored reference, which need not match (
  // C48). Everything that reads those columns — the price-history genesis point, the
  // belief-drift baseline, and the breaker's σ₀ — wants the true genesis summary.
  const initialBelief: BeliefModel = makeInitialBelief(dto);
  const beliefFields = beliefPersistFields(initialBelief);
  const model = resolveModel(dto);
  const oracle = await resolveOracleAssignment(dto);

  const market = await db.transaction(async (tx) => {
    // Non-infinite creators fund the reserve from their balance. Re-read the row
    // FOR UPDATE inside the tx and debit with an atomic delta (like
    // refundPositions / claimPayout) so a concurrent balance-affecting op can't
    // cause a lost update from a stale request-time snapshot.
    let lockedBalance = creator.balance;
    if (!creator.isInfinite) {
      const locked = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.userId, creator.userId))
        .for('update');
      lockedBalance = Number(locked[0]?.balance ?? creator.balance);
      if (lockedBalance < reserve) {
        throw new HttpError(400, 'Insufficient balance to fund the initial reserve');
      }
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${reserve}`, updatedAt: new Date() })
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
        beliefKind: initialBelief.kind,
        model,
        initialMu: beliefFields.currentMu,
        initialSigma: beliefFields.currentSigma,
        currentMu: beliefFields.currentMu,
        currentSigma: beliefFields.currentSigma,
        beliefState: beliefFields.beliefState,
        cfg: cfg as unknown as Record<string, number | boolean>,
        cash: reserve,
        reserveRequired: 0,
        lpSharesTotal: reserve,
        oracleMode: oracle.oracleMode,
        oracleUserId: oracle.oracleUserId,
        oracleToken: oracle.oracleToken,
        disputeWindowSec: oracle.disputeWindowSec,
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

    // Ledger: creating a market puts up the initial reserve from the creator's
    // wallet (−reserve). This same cash is their genesis LP stake, so we record
    // it once as market_create rather than double-counting an lp_deposit too.
    await recordTx(tx, {
      userId: creator.userId,
      kind: TransactionKind.MARKET_CREATE,
      amount: round8(-reserve),
      balanceAfter: creator.isInfinite ? null : round8(lockedBalance - reserve),
      marketId: m.marketId,
      refType: 'market',
      refId: m.marketId,
      metadata: { title: dto.title, reserve },
    });

    // Audit inside the tx — a post-commit insert failure would 5xx a market that
    // was in fact created (and a retry would create a duplicate).
    await writeAudit(
      {
        actorId: creator.userId,
        action: 'market_create',
        targetId: m.marketId,
        payload: {
          title: dto.title,
          initialReserve: reserve,
          mu: dto.initialMu,
          sigma: dto.initialSigma,
        },
      },
      tx,
    );

    return m;
  });

  return market;
}

export async function transitionMarket(
  // `null` ⇒ a system-driven transition (e.g. the oracle scheduler auto-
  // resolving an `api` market or auto-settling after the dispute window); the audit
  // row then carries a null actor.
  actor: UserRow | null,
  marketId: string,
  action: LifecycleAction,
  opts: { thetaStar?: number; oracleSource?: string; oracleConfidence?: number } = {},
): Promise<MarketRow> {
  const rule = ACTIONS[action];

  // Captured by the cancel branch for the audit trail (refund totals + any shortfall).
  let cancelSummary: { refunded: number; lpReturned: number; shortfall: number } | null = null;

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
        // stamp resolution time — this opens the post-RESOLVED dispute window.
        patch.resolvedAt = new Date();
        await tx.insert(oracles).values({
          marketId,
          source: opts.oracleSource ?? 'manual_admin',
          token: m.oracleToken,
          resolvedValue: opts.thetaStar,
          confidence: opts.oracleConfidence ?? 1,
        });
        // Compute every open position's payout into uncredited `claims` rows.
        await recordClaims(tx, marketId, opts.thetaStar);
      }
      if (action === 'cancel') {
        // Unwind: refund traders' open cost basis, then return the remaining pool
        // to LPs pro-rata by shares (: "LP refunded deposits; everyone made
        // whole"). CANCELLED is terminal — without this distribution LP cash would
        // be stranded forever (no withdraw/claim path leaves CANCELLED).
        const refunded = await refundPositions(tx, marketId);
        const afterRefund = subMoney(m.cash, refunded);
        // Refunds can exceed pool cash (an LP may have withdrawn mark-to-model
        // profit earlier): floor at 0 and surface the gap instead of booking
        // negative cash. Traders stay whole; the shortfall lands on LPs.
        const lpPool = Math.max(0, afterRefund);
        const shortfall = afterRefund < 0 ? round8(-afterRefund) : 0;

        let distributed = 0;
        if (m.lpSharesTotal > 0 && lpPool >= 0) {
          const lps = await tx.select().from(lpPositions).where(eq(lpPositions.marketId, marketId));
          for (const lp of lps) {
            if (lp.claimed || lp.shares <= 0) continue;
            const credited = Math.max(0, lpClaimAmount(lp.shares, m.lpSharesTotal, lpPool));
            const pnl = round8(credited + lp.totalWithdrawn - lp.totalDeposited);
            await tx
              .update(lpPositions)
              .set({ claimed: true, updatedAt: new Date() })
              .where(eq(lpPositions.lpId, lp.lpId));
            const ins = await tx
              .insert(lpLedger)
              .values({
                marketId,
                userId: lp.userId,
                kind: 'claim',
                amount: credited,
                sharesDelta: 0,
                navBefore: lpPool,
                sharePrice: lpSharePrice(lpPool, m.lpSharesTotal),
              })
              .returning({ entryId: lpLedger.entryId });
            const urows = await tx
              .select({ isInfinite: users.isInfinite })
              .from(users)
              .where(eq(users.userId, lp.userId));
            let balanceAfter: number | null = null;
            if (urows[0] && !urows[0].isInfinite && credited > 0) {
              const bal = await tx
                .update(users)
                .set({ balance: sql`${users.balance} + ${credited}`, updatedAt: new Date() })
                .where(eq(users.userId, lp.userId))
                .returning({ balance: users.balance });
              balanceAfter = round8(Number(bal[0]?.balance ?? 0));
            }
            await recordTx(tx, {
              userId: lp.userId,
              kind: TransactionKind.LP_CLAIM,
              amount: round8(credited),
              balanceAfter,
              marketId,
              refType: 'lp_ledger',
              refId: ins[0]?.entryId ?? null,
              metadata: { pnl, reason: 'market_cancelled' },
            });
            distributed = addMoney(distributed, credited);
          }
        }
        patch.cash = Math.max(0, subMoney(lpPool, distributed));
        cancelSummary = { refunded, lpReturned: distributed, shortfall };
      }
      if (action === 'open' && m.status === 'CREATED' && !m.opensAt) {
        patch.opensAt = new Date();
      }

      const res = await tx
        .update(markets)
        .set(patch)
        .where(eq(markets.marketId, marketId))
        .returning();

      // Audit inside the tx so a post-commit insert failure can't 5xx a
      // transition (refunds/claims included) that actually happened.
      await writeAudit(
        {
          actorId: actor?.userId ?? null,
          action: `market_${action}`,
          targetId: marketId,
          payload:
            action === 'resolve'
              ? { thetaStar: opts.thetaStar }
              : action === 'cancel' && cancelSummary
                ? cancelSummary
                : {},
        },
        tx,
      );

      return res[0] as MarketRow;
    }),
  );
  publish(topics.market(marketId), { type: 'market_status', status: updated.status });
  return updated;
}

export { marketRepo };
