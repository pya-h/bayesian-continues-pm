// LpSvc — reserve-pool liquidity provision.
// The pool is the MM's cash reserve; LPs own pro-rata shares of its NAV
// (= cash − E_p[L]). Deposits mint shares at the pre-deposit price and raise
// trading capacity; withdrawals burn shares at the live price but are gated so
// cash can't drop below the 1.2× solvency buffer (the required reserve is
// independent of cash, so the max withdrawable cash is a closed form
// `cash − 1.2·Reserve`). At settlement LPs split the residual
// `cash_final = cash − Σ trader_payouts` pro-rata via a separate claim.
// Deposit/withdraw are serialized on the market queue (+ `FOR UPDATE` on market
// and trader rows), consistent with the trade engine; claim locks the market and
// trader rows and is idempotent via the `claimed` flag.

import {
  type BookEntry,
  type EngineConfig,
  type ReserveOpts,
  expectedLiability,
  requiredReserve,
} from '@bmm/core';
import { TransactionKind, addMoney, round8, subMoney } from '@bmm/shared';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.ts';
import { db } from '../db/client.ts';
import { type UserRow, marketRepo } from '../db/repos.ts';
import { claims, contracts, lpLedger, lpPositions, markets, users } from '../db/schema.ts';
import { loadBelief } from '../lib/belief.ts';
import { specFromRow } from '../lib/contract.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';
import { recordTx } from './ledgerSvc.ts';
import {
  cashOutForShares,
  lpCashFinal,
  lpClaimAmount,
  lpSharePrice,
  sharesForDeposit,
} from './lpMath.ts';
import { withMarketLock } from './marketQueue.ts';

// Solvency buffer: cash must stay ≥ 1.2× required reserve after a withdrawal.
const WITHDRAW_MARGIN = 1.2;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function reserveOptsFor(cfg: EngineConfig): ReserveOpts {
  return { alpha: cfg.reserveAlpha, samples: config.reserve.mcSamples };
}

async function loadBookTx(tx: Tx, marketId: string): Promise<BookEntry[]> {
  const rows = await tx.select().from(contracts).where(eq(contracts.marketId, marketId));
  return rows.map((r) => ({ spec: specFromRow(r.type, r.params), mmShort: r.mmShort }));
}

export interface LpView {
  marketId: string;
  status: string;
  pool: {
    cash: number;
    reserveRequired: number;
    nav: number;
    sharesTotal: number;
    sharePrice: number;
  };
  your: {
    shares: number;
    sharePct: number;
    totalDeposited: number;
    totalWithdrawn: number;
    estValue: number;
    claimed: boolean;
  } | null;
}

export async function getLpView(marketId: string, userId?: string): Promise<LpView> {
  const m = await marketRepo.byId(marketId);
  if (!m) throw new HttpError(404, 'Market not found');

  const belief = loadBelief(m);
  const rows = await db.select().from(contracts).where(eq(contracts.marketId, marketId));
  const book: BookEntry[] = rows.map((r) => ({
    spec: specFromRow(r.type, r.params),
    mmShort: r.mmShort,
  }));
  const nav = round8(m.cash - expectedLiability(book, belief));
  const sharesTotal = m.lpSharesTotal;
  const sharePrice = lpSharePrice(nav, sharesTotal);

  let your: LpView['your'] = null;
  if (userId) {
    const lp = await db
      .select()
      .from(lpPositions)
      .where(and(eq(lpPositions.marketId, marketId), eq(lpPositions.userId, userId)))
      .limit(1);
    if (lp[0]) {
      const shares = lp[0].shares;
      your = {
        shares,
        sharePct: sharesTotal > 0 ? round8(shares / sharesTotal) : 0,
        totalDeposited: lp[0].totalDeposited,
        totalWithdrawn: lp[0].totalWithdrawn,
        estValue: cashOutForShares(shares, sharesTotal, nav),
        claimed: lp[0].claimed,
      };
    }
  }

  return {
    marketId,
    status: m.status,
    pool: { cash: m.cash, reserveRequired: m.reserveRequired, nav, sharesTotal, sharePrice },
    your,
  };
}

export interface LpDepositResult {
  minted: number;
  navBefore: number;
  lp: LpView;
}

// Deposit `amount` into the pool (OPEN only), minting pro-rata shares.
export async function deposit(
  actor: UserRow,
  marketId: string,
  amount: number,
): Promise<LpDepositResult> {
  const minted = await withMarketLock(marketId, () =>
    db.transaction(async (tx): Promise<{ minted: number; navBefore: number }> => {
      const mrows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, marketId))
        .for('update');
      const m = mrows[0];
      if (!m) throw new HttpError(404, 'Market not found');
      if (m.status !== 'OPEN') {
        throw new HttpError(409, 'Market is not open for liquidity provision');
      }

      const urows = await tx
        .select()
        .from(users)
        .where(eq(users.userId, actor.userId))
        .for('update');
      const u = urows[0];
      if (!u) throw new HttpError(404, 'User not found');
      if (!u.isInfinite && u.balance + 1e-9 < amount) {
        throw new HttpError(400, 'Insufficient balance to deposit');
      }

      const belief = loadBelief(m);
      const book = await loadBookTx(tx, marketId);
      const navBefore = round8(m.cash - expectedLiability(book, belief));
      // Genesis / re-genesis: with no shares outstanding (e.g. the last LP withdrew
      // everything while the market stayed OPEN) there is no pro-rata price to
      // dilute — mint at share price 1, like market creation. Without this branch
      // the `navBefore <= 0` guard bricked the market forever (every deposit 409s
      // every buy fails the solvency gate on cash = 0), and `sharesForDeposit`
      // would mint 0 shares for a real debit.
      const genesis = m.lpSharesTotal <= 0;
      if (genesis ? navBefore < 0 : navBefore <= 0) {
        throw new HttpError(409, 'Pool NAV is non-positive; deposits are paused');
      }

      const sharesMinted = genesis
        ? round8(amount)
        : sharesForDeposit(amount, m.lpSharesTotal, navBefore);
      await tx
        .update(markets)
        .set({
          cash: addMoney(m.cash, amount),
          lpSharesTotal: addMoney(m.lpSharesTotal, sharesMinted),
          updatedAt: new Date(),
        })
        .where(eq(markets.marketId, marketId));

      // Mint into the LP's position (deposits per market are serialized by the
      // market lock + transaction, so a read-modify-write is safe here).
      const existing = await tx
        .select()
        .from(lpPositions)
        .where(and(eq(lpPositions.marketId, marketId), eq(lpPositions.userId, u.userId)))
        .limit(1);
      if (existing[0]) {
        await tx
          .update(lpPositions)
          .set({
            shares: addMoney(existing[0].shares, sharesMinted),
            totalDeposited: addMoney(existing[0].totalDeposited, amount),
            updatedAt: new Date(),
          })
          .where(eq(lpPositions.lpId, existing[0].lpId));
      } else {
        await tx.insert(lpPositions).values({
          marketId,
          userId: u.userId,
          shares: sharesMinted,
          totalDeposited: amount,
        });
      }

      const depIns = await tx
        .insert(lpLedger)
        .values({
          marketId,
          userId: u.userId,
          kind: 'deposit',
          amount,
          sharesDelta: sharesMinted,
          navBefore,
          sharePrice: lpSharePrice(navBefore, m.lpSharesTotal),
        })
        .returning({ entryId: lpLedger.entryId });

      let balanceAfter: number | null = null;
      if (!u.isInfinite) {
        balanceAfter = round8(subMoney(u.balance, amount));
        await tx
          .update(users)
          .set({ balance: balanceAfter, updatedAt: new Date() })
          .where(eq(users.userId, u.userId));
      }

      // Ledger: depositing into the pool moves cash out of the LP's wallet.
      await recordTx(tx, {
        userId: u.userId,
        kind: TransactionKind.LP_DEPOSIT,
        amount: round8(-amount),
        balanceAfter,
        marketId,
        refType: 'lp_ledger',
        refId: depIns[0]?.entryId ?? null,
        metadata: { sharesMinted },
      });

      return { minted: sharesMinted, navBefore };
    }),
  );

  const lp = await getLpView(marketId, actor.userId);
  publishLpUpdate(marketId, lp);
  return { minted: minted.minted, navBefore: minted.navBefore, lp };
}

export interface LpWithdrawResult {
  cashOut: number;
  burned: number;
  partial: boolean;
  lp: LpView;
}

// Burn up to `shares` for cash (OPEN only), capped by the solvency buffer.
export async function withdraw(
  actor: UserRow,
  marketId: string,
  shares: number,
): Promise<LpWithdrawResult> {
  const out = await withMarketLock(marketId, () =>
    db.transaction(async (tx): Promise<{ cashOut: number; burned: number; partial: boolean }> => {
      const mrows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, marketId))
        .for('update');
      const m = mrows[0];
      if (!m) throw new HttpError(404, 'Market not found');
      if (m.status !== 'OPEN') {
        throw new HttpError(409, 'Market is not open for liquidity provision');
      }

      const urows = await tx
        .select()
        .from(users)
        .where(eq(users.userId, actor.userId))
        .for('update');
      const u = urows[0];
      if (!u) throw new HttpError(404, 'User not found');

      const lprows = await tx
        .select()
        .from(lpPositions)
        .where(and(eq(lpPositions.marketId, marketId), eq(lpPositions.userId, u.userId)))
        .limit(1);
      const lp = lprows[0];
      if (!lp || lp.shares <= 0) throw new HttpError(400, 'No LP shares to withdraw');
      if (shares > lp.shares + 1e-9) {
        throw new HttpError(400, `Cannot withdraw ${shares} shares; you hold ${lp.shares}`);
      }

      const belief = loadBelief(m);
      const book = await loadBookTx(tx, marketId);
      const nav = round8(m.cash - expectedLiability(book, belief));
      if (nav <= 0) throw new HttpError(409, 'Pool NAV is non-positive; withdrawals are paused');

      const reserve = requiredReserve(
        book,
        belief,
        reserveOptsFor(m.cfg as unknown as EngineConfig),
      );
      const maxCashOut = round8(Math.max(0, m.cash - WITHDRAW_MARGIN * reserve));
      if (maxCashOut <= 0) {
        throw new HttpError(409, 'Withdrawal would breach the solvency buffer');
      }

      const reqCashOut = cashOutForShares(shares, m.lpSharesTotal, nav);
      let cashOut: number;
      let burned: number;
      let partial: boolean;
      if (reqCashOut <= maxCashOut) {
        cashOut = reqCashOut;
        burned = shares;
        partial = false;
      } else {
        cashOut = maxCashOut;
        burned = round8((cashOut / nav) * m.lpSharesTotal);
        if (burned > lp.shares) burned = lp.shares;
        partial = true;
      }

      await tx
        .update(markets)
        .set({
          cash: subMoney(m.cash, cashOut),
          lpSharesTotal: subMoney(m.lpSharesTotal, burned),
          updatedAt: new Date(),
        })
        .where(eq(markets.marketId, marketId));

      await tx
        .update(lpPositions)
        .set({
          shares: subMoney(lp.shares, burned),
          totalWithdrawn: addMoney(lp.totalWithdrawn, cashOut),
          updatedAt: new Date(),
        })
        .where(eq(lpPositions.lpId, lp.lpId));

      const wIns = await tx
        .insert(lpLedger)
        .values({
          marketId,
          userId: u.userId,
          kind: 'withdraw',
          amount: cashOut,
          sharesDelta: round8(-burned),
          navBefore: nav,
          sharePrice: lpSharePrice(nav, m.lpSharesTotal),
        })
        .returning({ entryId: lpLedger.entryId });

      let balanceAfter: number | null = null;
      if (!u.isInfinite) {
        balanceAfter = round8(addMoney(u.balance, cashOut));
        await tx
          .update(users)
          .set({ balance: balanceAfter, updatedAt: new Date() })
          .where(eq(users.userId, u.userId));
      }

      // Ledger: withdrawing from the pool moves cash into the LP's wallet.
      await recordTx(tx, {
        userId: u.userId,
        kind: TransactionKind.LP_WITHDRAW,
        amount: round8(cashOut),
        balanceAfter,
        marketId,
        refType: 'lp_ledger',
        refId: wIns[0]?.entryId ?? null,
        metadata: { sharesBurned: round8(burned), partial },
      });

      return { cashOut, burned, partial };
    }),
  );

  const lp = await getLpView(marketId, actor.userId);
  publishLpUpdate(marketId, lp);
  return { ...out, lp };
}

export interface LpClaimResult {
  credited: number;
  pnl: number;
  alreadyClaimed: boolean;
  cashFinal: number;
  lp: LpView;
}

// Settlement claim (SETTLED or CLOSED): credit this LP's pro-rata share of the
// residual `cash_final = cash − Σ trader_payouts`. Idempotent — a second call
// after `claimed` is a no-op. `S_total` is left untouched so concurrent LPs each
// receive the correct fraction. Limited liability: a negative split (pool that
// paid out more than its cash) credits 0, never claws back. Claims stay open on
// CLOSED so archival can't strand an LP's residual; cash_final is stable
// because the pool freezes at settlement.
export async function claim(actor: UserRow, marketId: string): Promise<LpClaimResult> {
  const out = await db.transaction(
    async (
      tx,
    ): Promise<{ credited: number; pnl: number; alreadyClaimed: boolean; cashFinal: number }> => {
      const mrows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, marketId))
        .for('update');
      const m = mrows[0];
      if (!m) throw new HttpError(404, 'Market not found');
      if (m.status !== 'SETTLED' && m.status !== 'CLOSED') {
        throw new HttpError(409, 'Market is not settled; LP claims are not open');
      }

      const urows = await tx
        .select()
        .from(users)
        .where(eq(users.userId, actor.userId))
        .for('update');
      const u = urows[0];
      if (!u) throw new HttpError(404, 'User not found');

      const lprows = await tx
        .select()
        .from(lpPositions)
        .where(and(eq(lpPositions.marketId, marketId), eq(lpPositions.userId, u.userId)))
        .limit(1);
      const lp = lprows[0];
      if (!lp) throw new HttpError(400, 'No LP position in this market');

      const crows = await tx
        .select({ payout: claims.payout })
        .from(claims)
        .where(eq(claims.marketId, marketId));
      const totalPayouts = round8(crows.reduce((s, c) => s + c.payout, 0));
      const cashFinal = lpCashFinal(m.cash, totalPayouts);

      if (lp.claimed) {
        return { credited: 0, pnl: 0, alreadyClaimed: true, cashFinal };
      }

      const raw = lpClaimAmount(lp.shares, m.lpSharesTotal, cashFinal);
      const credited = Math.max(0, raw); // limited liability
      const pnl = round8(credited + lp.totalWithdrawn - lp.totalDeposited);

      await tx
        .update(lpPositions)
        .set({ claimed: true, updatedAt: new Date() })
        .where(eq(lpPositions.lpId, lp.lpId));

      const cIns = await tx
        .insert(lpLedger)
        .values({
          marketId,
          userId: u.userId,
          kind: 'claim',
          amount: credited,
          sharesDelta: 0,
          navBefore: cashFinal,
          sharePrice: lpSharePrice(cashFinal, m.lpSharesTotal),
        })
        .returning({ entryId: lpLedger.entryId });

      let balanceAfter: number | null = null;
      if (!u.isInfinite) {
        balanceAfter = round8(addMoney(u.balance, credited));
        await tx
          .update(users)
          .set({ balance: balanceAfter, updatedAt: new Date() })
          .where(eq(users.userId, u.userId));
      }

      // Ledger: LP settlement payout into the LP's wallet (+credited; may be 0
      // under limited liability). pnl folds in prior deposits/withdrawals.
      await recordTx(tx, {
        userId: u.userId,
        kind: TransactionKind.LP_CLAIM,
        amount: round8(credited),
        balanceAfter,
        marketId,
        refType: 'lp_ledger',
        refId: cIns[0]?.entryId ?? null,
        metadata: { pnl },
      });

      return { credited, pnl, alreadyClaimed: false, cashFinal };
    },
  );

  const lp = await getLpView(marketId, actor.userId);
  if (out.credited > 0) {
    publish(topics.user(actor.userId), { type: 'lp_claim', marketId, amount: out.credited });
  }
  return { ...out, lp };
}

function publishLpUpdate(marketId: string, lp: LpView): void {
  publish(topics.market(marketId), {
    type: 'lp_update',
    nav: lp.pool.nav,
    sharesTotal: lp.pool.sharesTotal,
    sharePrice: lp.pool.sharePrice,
    cash: lp.pool.cash,
  });
}
