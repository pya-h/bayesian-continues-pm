// Append-only audit log for admin actions (top-ups, lifecycle, …).

import { db } from '../db/client.ts';
import { auditEvents } from '../db/schema.ts';

export async function writeAudit(opts: {
  actorId: string | null;
  action: string;
  targetId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: opts.actorId,
    action: opts.action,
    targetId: opts.targetId ?? null,
    payload: opts.payload ?? null,
  });
}
