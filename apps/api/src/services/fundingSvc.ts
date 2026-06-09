// FundingSvc — admin balance top-ups, ledgered (TASKS ).
// A top-up credits the target user from the platform (the admin is the infinite
// source). It records two ledger rows in one transaction so the move shows in
// both histories: `admin_credit` on the funded user (+amount) and `admin_grant`
// on the admin who dispensed it (−amount). Infinite accounts keep `balanceAfter`
// null (their balance isn't tracked) and aren't actually mutated.

import { TransactionKind, addMoney, round8 } from '@bmm/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type UserRow, userRepo } from '../db/repos.ts';
import { users } from '../db/schema.ts';
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
      balanceAfter = round8(addMoney(target.balance, amount));
      const rows = await tx
        .update(users)
        .set({ balance: balanceAfter, updatedAt: new Date() })
        .where(eq(users.userId, target.userId))
        .returning();
      updated = (rows[0] as UserRow) ?? target;
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
    // Admin's view: they dispensed it (record line; admin is the infinite source).
    await recordTx(tx, {
      userId: admin.userId,
      kind: TransactionKind.ADMIN_GRANT,
      amount: round8(-amount),
      balanceAfter: admin.isInfinite ? null : round8(admin.balance),
      counterpartyId: target.userId,
      refType: 'topup',
      metadata: { to: target.username },
    });

    return { user: updated, credited: target.isInfinite ? 0 : round8(amount) };
  });
}
