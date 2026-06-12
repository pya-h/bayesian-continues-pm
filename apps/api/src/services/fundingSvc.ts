// FundingSvc — admin balance top-ups, ledgered (TASKS ).
// A top-up credits the target user from the platform (the admin is the infinite
// source). It records two ledger rows in one transaction so the move shows in
// both histories: `admin_credit` on the funded user (+amount) and `admin_grant`
// on the admin who dispensed it (−amount). Infinite accounts keep `balanceAfter`
// null (their balance isn't tracked) and aren't actually mutated.

import { TransactionKind, round8 } from '@bmm/shared';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type UserRow, userRepo } from '../db/repos.ts';
import { users } from '../db/schema.ts';
import { writeAudit } from '../lib/audit.ts';
import { recordTx } from './ledgerSvc.ts';

export interface TopupResult {
  user: UserRow;
  credited: number;
}

// Credit `amount` to `targetId` and ledger it on both sides. Returns the updated
// target row. Throws via the caller if the target doesn't exist (caller checks).
export async function adminTopup(
  admin: UserRow,
  target: UserRow,
  amount: number,
): Promise<TopupResult> {
  return db.transaction(async (tx) => {
    let updated = target;
    let balanceAfter: number | null = null;
    if (!target.isInfinite) {
      // Atomic delta (like refundPositions/claimPayout): the request-time snapshot
      // can be stale, so writing `snapshot + amount` absolutely would clobber any
      // concurrent trade/claim/top-up that committed in between.
      const rows = await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${amount}`, updatedAt: new Date() })
        .where(eq(users.userId, target.userId))
        .returning();
      updated = (rows[0] as UserRow) ?? target;
      balanceAfter = round8(Number(updated.balance));
    }

    // Funded user's view: money entered the platform for them.
    await recordTx(tx, {
      userId: target.userId,
      kind: TransactionKind.ADMIN_CREDIT,
      amount: round8(amount),
      balanceAfter,
      counterpartyId: admin.userId,
      refType: 'topup',
      metadata: { by: admin.username },
    });
    // Admin's view: they dispensed it. An infinite admin is the untracked source
    // (balanceAfter null, no mutation); a non-infinite admin is actually debited
    // so the grant row's books balance.
    let adminBalanceAfter: number | null = null;
    if (!admin.isInfinite) {
      const arows = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${amount}`, updatedAt: new Date() })
        .where(eq(users.userId, admin.userId))
        .returning();
      adminBalanceAfter = round8(Number((arows[0] as UserRow | undefined)?.balance ?? 0));
    }
    await recordTx(tx, {
      userId: admin.userId,
      kind: TransactionKind.ADMIN_GRANT,
      amount: round8(-amount),
      balanceAfter: adminBalanceAfter,
      counterpartyId: target.userId,
      refType: 'topup',
      metadata: { to: target.username },
    });

    // Audit inside the tx — a post-commit audit failure would 5xx a credit that
    // landed, inviting a double-crediting retry.
    await writeAudit(
      {
        actorId: admin.userId,
        action: 'topup',
        targetId: target.userId,
        payload: { amount, infinite: target.isInfinite },
      },
      tx,
    );

    return { user: updated, credited: target.isInfinite ? 0 : round8(amount) };
  });
}
