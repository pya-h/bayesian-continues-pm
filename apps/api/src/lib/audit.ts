// Append-only audit log for admin actions (top-ups, lifecycle, …).

import { db } from '../db/client.ts';
import { auditEvents } from '../db/schema.ts';

type DbLike = Pick<typeof db, 'insert'>;

// Insert an audit row. Pass the surrounding transaction as `dbc` for actions that
// commit money/state (trades, lifecycle): an audit insert that runs *after* the
// commit can fail and turn an executed action into a client-facing 5xx — and with
// no idempotency key on the trade route, a natural retry would double-trade.
export async function writeAudit(
  opts: {
    actorId: string | null;
    action: string;
    targetId?: string | null;
    payload?: Record<string, unknown>;
  },
  dbc: DbLike = db,
): Promise<void> {
  await dbc.insert(auditEvents).values({
    actorId: opts.actorId,
    action: opts.action,
    targetId: opts.targetId ?? null,
    payload: opts.payload ?? null,
  });
}
