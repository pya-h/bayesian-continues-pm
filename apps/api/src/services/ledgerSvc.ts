// LedgerSvc — the write side of the transaction ledger (TASKS ).
// `recordTx` / `recordTxs` insert `transactions` rows. They take the caller's
// executor (the `Tx` handed to `db.transaction(cb)`, or `db` itself) so the
// ledger row commits atomically with the balance/cash mutation that caused it —
// if the surrounding transaction rolls back, the ledger row vanishes with it.
// That atomicity is the whole point: the ledger can never disagree with reality.
// `amount` is signed from the row owner's wallet perspective (+ inflow to their
// balance, − outflow). `balanceAfter` is the user's balance right after the move
// or null for infinite/admin accounts whose balance isn't tracked.

import type { TransactionKind } from '@bmm/shared';
import { round8 } from '@bmm/shared';
import type { db } from '../db/client.ts';
import { transactions } from '../db/schema.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<Tx, 'insert'>;

export interface LedgerEntry {
  userId: string;
  kind: TransactionKind;
  amount: number;
  balanceAfter?: number | null;
  marketId?: string | null;
  counterpartyId?: string | null;
  refType?: string | null;
  refId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function toRow(e: LedgerEntry) {
  return {
    userId: e.userId,
    kind: e.kind,
    amount: round8(e.amount),
    balanceAfter: e.balanceAfter == null ? null : round8(e.balanceAfter),
    marketId: e.marketId ?? null,
    counterpartyId: e.counterpartyId ?? null,
    refType: e.refType ?? null,
    refId: e.refId ?? null,
    metadata: e.metadata ?? null,
  };
}

export async function recordTx(exec: Executor, entry: LedgerEntry): Promise<void> {
  await exec.insert(transactions).values(toRow(entry));
}

export async function recordTxs(exec: Executor, entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await exec.insert(transactions).values(entries.map(toRow));
}
