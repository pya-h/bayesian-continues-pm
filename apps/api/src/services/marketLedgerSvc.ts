// MarketLedgerSvc — the admin-only "bank statement" for a single market's cash
// pool (TASKS / MH-1). Read-only: no new write path. The ledger is
// *reconstructed by aggregation* from data we already store.
// `markets.cash` (the pool) is mutated by exactly four kinds of event
// • genesis reserve — the creator's initial liquidity (an `lp_ledger` deposit
// with `navBefore = 0`), which seeds `cash = R₀`
// • LP deposits / withdrawals — later `lp_ledger` deposit/withdraw rows
// • trade premiums — each `trades.totalCost` (signed: buy > 0 in, sell < 0 out)
// • cancel refunds — the per-trader `transactions` refund rows whose sum is the
// amount `cash` was reduced by when the market was cancelled.
// Summing the signed pool deltas of those events therefore reconciles to the
// live `markets.cash` — `rollup.netPoolChange === currentCash`.
// Settlement *distributions* — trader payouts (`claims`) and LP settlement claims
// (`lp_ledger` kind `claim`) — are shown too, but by design they do NOT mutate
// `markets.cash` (the residual `cash − Σ payouts` is computed logically at claim
// time). They carry `affectsCash: false` and don't advance the running balance
// they appear in the rollup as `traderPayouts` / `lpClaimsPaid` for the full
// economic picture.
// Exception: on a CANCELLED market the LP `claim` rows are the cancel-time
// pro-rata return of the pool, which DOES drain `markets.cash` to 0 — those carry
// `affectsCash: true` so the statement still reconciles. (CANCELLED and SETTLED
// are mutually exclusive terminal states, so the market status fully determines
// which semantics a claim row has.)

import { expectedLiability } from '@bmm/core';
import { round8 } from '@bmm/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { claims, contracts, lpLedger, markets, trades, transactions, users } from '../db/schema.ts';
import { loadBelief } from '../lib/belief.ts';
import { specFromRow } from '../lib/contract.ts';
import { HttpError } from '../lib/errors.ts';

export type MarketLedgerKind =
  | 'genesis'
  | 'lp_deposit'
  | 'lp_withdraw'
  | 'lp_claim'
  | 'trade_buy'
  | 'trade_sell'
  | 'refund'
  | 'trader_payout';

export interface MarketLedgerEvent {
  at: string;
  kind: MarketLedgerKind;
  delta: number;
  affectsCash: boolean;
  cashAfter: number | null;
  userId: string | null;
  username: string | null;
  ref: { type: string; id: string } | null;
  note?: string;
}

export interface MarketLedgerRollup {
  genesisReserve: number;
  // Σ later LP deposits (excludes the genesis reserve).
  lpDeposits: number;
  lpWithdrawals: number;
  // Σ buy premiums into the pool.
  premiumIn: number;
  // Σ sell premiums paid out of the pool (magnitude).
  premiumOut: number;
  // Σ cancel refunds returned to traders (magnitude).
  refunds: number;
  // Σ recorded trader settlement payouts (claims liability).
  traderPayouts: number;
  // Σ LP settlement claims actually paid.
  lpClaimsPaid: number;
  // Σ of every cash-affecting delta — reconciles to `currentCash`.
  netPoolChange: number;
  currentCash: number;
  reserveRequired: number;
  nav: number;
  // LP residual at settlement = cash − Σ trader payouts.
  cashFinal: number;
  reconciles: boolean;
  tradeCount: number;
  lpEventCount: number;
  eventCount: number;
}

export interface MarketLedger {
  marketId: string;
  title: string;
  status: string;
  createdAt: string;
  events: MarketLedgerEvent[];
  rollup: MarketLedgerRollup;
}

function byTime(a: MarketLedgerEvent, b: MarketLedgerEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.kind === 'genesis') return -1;
  if (b.kind === 'genesis') return 1;
  return 0;
}

// Assemble the full cash-flow statement for one market. Admin-only (read-only).
export async function getMarketLedger(marketId: string): Promise<MarketLedger> {
  const mrows = await db.select().from(markets).where(eq(markets.marketId, marketId)).limit(1);
  const m = mrows[0];
  if (!m) throw new HttpError(404, 'Market not found');

  const [lpRows, tradeRows, refundRows, claimRows, contractRows] = await Promise.all([
    db
      .select({
        entryId: lpLedger.entryId,
        userId: lpLedger.userId,
        username: users.username,
        kind: lpLedger.kind,
        amount: lpLedger.amount,
        navBefore: lpLedger.navBefore,
        createdAt: lpLedger.createdAt,
      })
      .from(lpLedger)
      .leftJoin(users, eq(lpLedger.userId, users.userId))
      .where(eq(lpLedger.marketId, marketId)),
    db
      .select({
        tradeId: trades.tradeId,
        userId: trades.userId,
        username: users.username,
        side: trades.side,
        quantity: trades.quantity,
        totalCost: trades.totalCost,
        createdAt: trades.createdAt,
      })
      .from(trades)
      .leftJoin(users, eq(trades.userId, users.userId))
      .where(eq(trades.marketId, marketId)),
    db
      .select({
        txId: transactions.txId,
        userId: transactions.userId,
        username: users.username,
        amount: transactions.amount,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .leftJoin(users, eq(transactions.userId, users.userId))
      .where(and(eq(transactions.marketId, marketId), eq(transactions.kind, 'refund'))),
    db
      .select({
        claimId: claims.claimId,
        userId: claims.userId,
        username: users.username,
        payout: claims.payout,
        claimedAt: claims.claimedAt,
        createdAt: claims.createdAt,
      })
      .from(claims)
      .leftJoin(users, eq(claims.userId, users.userId))
      .where(eq(claims.marketId, marketId)),
    db.select().from(contracts).where(eq(contracts.marketId, marketId)),
  ]);

  const events: MarketLedgerEvent[] = [];

  for (const r of lpRows) {
    if (r.kind === 'deposit') {
      const genesis = r.navBefore === 0;
      events.push({
        at: r.createdAt.toISOString(),
        kind: genesis ? 'genesis' : 'lp_deposit',
        delta: round8(r.amount),
        affectsCash: true,
        cashAfter: null,
        userId: r.userId,
        username: r.username,
        ref: { type: 'lp_ledger', id: r.entryId },
        note: genesis ? 'initial liquidity' : undefined,
      });
    } else if (r.kind === 'withdraw') {
      events.push({
        at: r.createdAt.toISOString(),
        kind: 'lp_withdraw',
        delta: round8(-r.amount),
        affectsCash: true,
        cashAfter: null,
        userId: r.userId,
        username: r.username,
        ref: { type: 'lp_ledger', id: r.entryId },
      });
    } else {
      // kind === 'claim' — on SETTLED markets a logical settlement distribution
      // (markets.cash untouched); on CANCELLED markets the cancel-time pro-rata
      // return of the pool, which really moved cash.
      const isCancelReturn = m.status === 'CANCELLED';
      events.push({
        at: r.createdAt.toISOString(),
        kind: 'lp_claim',
        delta: round8(-r.amount),
        affectsCash: isCancelReturn,
        cashAfter: null,
        userId: r.userId,
        username: r.username,
        ref: { type: 'lp_ledger', id: r.entryId },
        note: isCancelReturn ? 'cancellation return' : 'settlement claim',
      });
    }
  }

  for (const r of tradeRows) {
    events.push({
      at: r.createdAt.toISOString(),
      kind: r.side === 'buy' ? 'trade_buy' : 'trade_sell',
      delta: round8(r.totalCost), // signed: buy > 0 in, sell < 0 out
      affectsCash: true,
      cashAfter: null,
      userId: r.userId,
      username: r.username,
      ref: { type: 'trade', id: r.tradeId },
      note: `${r.side} ${round8(Math.abs(r.quantity))}`,
    });
  }

  for (const r of refundRows) {
    events.push({
      at: r.createdAt.toISOString(),
      kind: 'refund',
      delta: round8(-r.amount), // refund leaves the pool back to the trader
      affectsCash: true,
      cashAfter: null,
      userId: r.userId,
      username: r.username,
      ref: { type: 'transaction', id: r.txId },
      note: 'cancellation refund',
    });
  }

  for (const r of claimRows) {
    events.push({
      at: r.createdAt.toISOString(),
      kind: 'trader_payout',
      delta: round8(-r.payout),
      affectsCash: false,
      cashAfter: null,
      userId: r.userId,
      username: r.username,
      ref: { type: 'claim', id: r.claimId },
      note: r.claimedAt ? 'paid' : 'unclaimed',
    });
  }

  events.sort(byTime);

  // Running pool cash over the cash-affecting events, in time order.
  let running = 0;
  for (const e of events) {
    if (!e.affectsCash) continue;
    running = round8(running + e.delta);
    e.cashAfter = running;
  }

  // Rollups.
  const sum = (xs: number[]) => round8(xs.reduce((s, x) => s + x, 0));
  const genesisReserve = sum(events.filter((e) => e.kind === 'genesis').map((e) => e.delta));
  const lpDeposits = sum(events.filter((e) => e.kind === 'lp_deposit').map((e) => e.delta));
  const lpWithdrawals = sum(events.filter((e) => e.kind === 'lp_withdraw').map((e) => -e.delta));
  const premiumIn = sum(events.filter((e) => e.kind === 'trade_buy').map((e) => e.delta));
  const premiumOut = sum(events.filter((e) => e.kind === 'trade_sell').map((e) => -e.delta));
  const refunds = sum(events.filter((e) => e.kind === 'refund').map((e) => -e.delta));
  const traderPayouts = sum(claimRows.map((r) => r.payout));
  const lpClaimsPaid = sum(events.filter((e) => e.kind === 'lp_claim').map((e) => -e.delta));

  const belief = loadBelief(m);
  const book = contractRows.map((r) => ({
    spec: specFromRow(r.type, r.params),
    mmShort: r.mmShort,
  }));
  const nav = round8(m.cash - expectedLiability(book, belief));

  const rollup: MarketLedgerRollup = {
    genesisReserve,
    lpDeposits,
    lpWithdrawals,
    premiumIn,
    premiumOut,
    refunds,
    traderPayouts,
    lpClaimsPaid,
    netPoolChange: running,
    currentCash: round8(m.cash),
    reserveRequired: round8(m.reserveRequired),
    nav,
    cashFinal: round8(m.cash - traderPayouts),
    reconciles: Math.abs(running - m.cash) < 1e-6,
    tradeCount: tradeRows.length,
    lpEventCount: lpRows.length,
    eventCount: events.length,
  };

  return {
    marketId: m.marketId,
    title: m.title,
    status: m.status,
    createdAt: m.createdAt.toISOString(),
    events,
    rollup,
  };
}
