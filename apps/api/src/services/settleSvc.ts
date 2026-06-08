// SettleSvc — resolution payouts, trader claims, and cancellation refunds
// .
// Lifecycle hooks (run inside the lifecycle transaction in marketSvc)
// • recordClaims — at resolve(θ*): one `claims` row per open position holding
// its computed payout (quantity · f(θ*)), uncredited. Returns Σ payouts so the
// LP settlement can split `cash − Σ user_payouts`.
// • refundPositions — at cancel: refund each trader the cost basis still locked
// in their open positions (quantity · avgEntryPrice) and shrink MM cash to
// match. Returns Σ refunds.
// `claimPayout` is the user-facing credit step (SETTLED markets only): idempotent
// it credits the trader's recorded payouts to their balance exactly once
// serialized on the trader row (`FOR UPDATE`) so a double-submit can't double-pay.

import { round8 } from '@bmm/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { UserRow } from '../db/repos.ts';
import { claims, contracts, markets, positions, users } from '../db/schema.ts';
import { specFromRow } from '../lib/contract.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';
import { positionPayout, positionRefund } from './settleMath.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Compute and persist a payout claim for every open position in a resolved
// market. Idempotent by construction: resolve is a one-shot status transition
// and `claims.positionId` is unique. Returns the total trader payout liability.
export async function recordClaims(tx: Tx, marketId: string, thetaStar: number): Promise<number> {
  const rows = await tx
    .select({
      positionId: positions.positionId,
      userId: positions.userId,
      quantity: positions.quantity,
      type: contracts.type,
      params: contracts.params,
    })
    .from(positions)
    .innerJoin(contracts, eq(positions.contractId, contracts.contractId))
    .where(eq(positions.marketId, marketId));

  let total = 0;
  for (const r of rows) {
    if (r.quantity <= 0) continue; // fully-closed position, nothing to settle
    const spec = specFromRow(r.type, r.params);
    const payout = positionPayout(spec, r.quantity, thetaStar);
    total += payout;
    await tx.insert(claims).values({
      marketId,
      userId: r.userId,
      positionId: r.positionId,
      payout,
      thetaStar,
    });
  }
  return round8(total);
}

// Unwind a cancelled market: refund each non-infinite trader the cost basis still
// locked in their open positions and reduce MM cash by the same total (the
// premium it had collected flows back). Returns Σ refunds. Balance increments use
// an atomic SQL expression so a trader trading elsewhere isn't clobbered.
export async function refundPositions(tx: Tx, marketId: string): Promise<number> {
  const rows = await tx
    .select({
      userId: positions.userId,
      quantity: positions.quantity,
      avgEntryPrice: positions.avgEntryPrice,
      isInfinite: users.isInfinite,
    })
    .from(positions)
    .innerJoin(users, eq(positions.userId, users.userId))
    .where(eq(positions.marketId, marketId));

  const byUser = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (r.quantity <= 0 || r.isInfinite) continue;
    const refund = positionRefund(r.quantity, r.avgEntryPrice);
    if (refund <= 0) continue;
    byUser.set(r.userId, round8((byUser.get(r.userId) ?? 0) + refund));
    total += refund;
  }

  for (const [userId, amount] of byUser) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: new Date() })
      .where(eq(users.userId, userId));
  }
  return round8(total);
}

export interface ClaimResult {
  marketId: string;
  credited: number;
  payout: number;
  alreadyClaimed: boolean;
  balance: number | null;
}

// Credit a trader's recorded payouts for a SETTLED market to their balance, once.
// Serialized on the trader row so concurrent submits can't double-pay; a second
// call after the first finds nothing pending and is a no-op (`credited: 0`).
export async function claimPayout(actor: UserRow, marketId: string): Promise<ClaimResult> {
  const result = await db.transaction(async (tx): Promise<ClaimResult> => {
    const mrows = await tx
      .select()
      .from(markets)
      .where(eq(markets.marketId, marketId))
      .for('update');
    const m = mrows[0];
    if (!m) throw new HttpError(404, 'Market not found');
    if (m.status !== 'SETTLED') {
      throw new HttpError(409, 'Market is not settled; nothing to claim yet');
    }

    // Lock the trader row so a concurrent claim waits and then sees no pending rows.
    const urows = await tx.select().from(users).where(eq(users.userId, actor.userId)).for('update');
    const u = urows[0];
    if (!u) throw new HttpError(404, 'User not found');

    const myClaims = await tx
      .select()
      .from(claims)
      .where(and(eq(claims.marketId, marketId), eq(claims.userId, u.userId)));

    const payoutTotal = round8(myClaims.reduce((s, c) => s + c.payout, 0));
    const pending = myClaims.filter((c) => c.claimedAt === null);
    if (pending.length === 0) {
      return {
        marketId,
        credited: 0,
        payout: payoutTotal,
        alreadyClaimed: myClaims.length > 0,
        balance: u.isInfinite ? null : u.balance,
      };
    }

    const credited = round8(pending.reduce((s, c) => s + c.payout, 0));
    const now = new Date();
    for (const c of pending) {
      await tx.update(claims).set({ claimedAt: now }).where(eq(claims.claimId, c.claimId));
    }

    let balance: number | null = null;
    if (!u.isInfinite) {
      const upd = await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${credited}::numeric`, updatedAt: now })
        .where(eq(users.userId, u.userId))
        .returning({ balance: users.balance });
      balance = upd[0]?.balance ?? null;
    }

    return { marketId, credited, payout: payoutTotal, alreadyClaimed: false, balance };
  });

  if (result.credited > 0) {
    publish(topics.user(actor.userId), {
      type: 'claim_paid',
      marketId,
      amount: result.credited,
      balance: result.balance,
    });
  }
  return result;
}
