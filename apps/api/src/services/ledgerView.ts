// LedgerView — the read side of the transaction ledger (TASKS / TX-2).
// `getUserTransactions` returns one user's history newest-first, joined to the
// market title and the counterparty username (for admin grants/credits), plus a
// `summary` of lifetime totals. `summarizeTransactions` is pure so it can be
// unit-tested and reused client-side. Filtering/sorting beyond newest-first is
// left to the client (the list is small at play-money scale).

import { TransactionKind, round8 } from '@bmm/shared';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { markets, transactions, users } from '../db/schema.ts';

export interface TransactionView {
  txId: string;
  kind: TransactionKind;
  amount: number;
  balanceAfter: number | null;
  marketId: string | null;
  marketTitle: string | null;
  counterpartyId: string | null;
  counterparty: string | null;
  refType: string | null;
  refId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface TransactionSummary {
  count: number;
  // Σ admin_credit — money that entered the platform for this user.
  funded: number;
  // Σ claim + lp_claim — total claimed out of the platform.
  claimed: number;
  // Σ |trade_buy| — gross premium spent buying.
  tradeBuy: number;
  // Σ trade_sell — gross proceeds from selling.
  tradeSell: number;
  // Σ |lp_deposit| — total provided as liquidity (incl. market creation).
  lpDeposited: number;
  // Σ lp_withdraw — total liquidity withdrawn.
  lpWithdrawn: number;
  // Σ refund — returned on cancelled markets.
  refunded: number;
  // Σ of every amount — net wallet effect of all recorded moves.
  net: number;
}

export function summarizeTransactions(
  rows: { kind: string; amount: number }[],
): TransactionSummary {
  const s: TransactionSummary = {
    count: rows.length,
    funded: 0,
    claimed: 0,
    tradeBuy: 0,
    tradeSell: 0,
    lpDeposited: 0,
    lpWithdrawn: 0,
    refunded: 0,
    net: 0,
  };
  for (const r of rows) {
    s.net += r.amount;
    switch (r.kind) {
      case TransactionKind.ADMIN_CREDIT:
        s.funded += r.amount;
        break;
      case TransactionKind.CLAIM:
      case TransactionKind.LP_CLAIM:
        s.claimed += r.amount;
        break;
      case TransactionKind.TRADE_BUY:
        s.tradeBuy += -r.amount; // recorded negative; report magnitude
        break;
      case TransactionKind.TRADE_SELL:
        s.tradeSell += r.amount;
        break;
      case TransactionKind.MARKET_CREATE:
      case TransactionKind.LP_DEPOSIT:
        s.lpDeposited += -r.amount; // outflow magnitude (genesis reserve + deposits)
        break;
      case TransactionKind.LP_WITHDRAW:
        s.lpWithdrawn += r.amount;
        break;
      case TransactionKind.REFUND:
        s.refunded += r.amount;
        break;
    }
  }
  for (const k of [
    'funded',
    'claimed',
    'tradeBuy',
    'tradeSell',
    'lpDeposited',
    'lpWithdrawn',
    'refunded',
    'net',
  ] as const) {
    s[k] = round8(s[k]);
  }
  return s;
}

export interface UserTransactions {
  transactions: TransactionView[];
  summary: TransactionSummary;
}

export async function getUserTransactions(userId: string): Promise<UserTransactions> {
  const rows = await db
    .select({
      txId: transactions.txId,
      kind: transactions.kind,
      amount: transactions.amount,
      balanceAfter: transactions.balanceAfter,
      marketId: transactions.marketId,
      marketTitle: markets.title,
      counterpartyId: transactions.counterpartyId,
      counterparty: users.username,
      refType: transactions.refType,
      refId: transactions.refId,
      metadata: transactions.metadata,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .leftJoin(markets, eq(transactions.marketId, markets.marketId))
    .leftJoin(users, eq(transactions.counterpartyId, users.userId))
    .where(eq(transactions.userId, userId))
    .orderBy(desc(transactions.createdAt));

  const views: TransactionView[] = rows.map((r) => ({
    txId: r.txId,
    kind: r.kind,
    amount: r.amount,
    balanceAfter: r.balanceAfter,
    marketId: r.marketId,
    marketTitle: r.marketTitle,
    counterpartyId: r.counterpartyId,
    counterparty: r.counterparty,
    refType: r.refType,
    refId: r.refId,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  }));

  return { transactions: views, summary: summarizeTransactions(views) };
}
