// AuditView — the read side of the admin audit log. The write side is
// `lib/audit.ts` (`writeAudit`), which records privileged / lifecycle / trade
// actions into `audit_events`; this is the viewer the admin panel renders.
// `getAuditEvents` returns events newest-first (hard-capped), each joined to the
// actor's username and a resolved **target label** — a market title or a
// username, depending on what the action targeted (`targetId` is a bare uuid in
// the table). Filtering/sorting beyond newest-first is left to the client (the
// log is small at play-money scale and the cap bounds the payload).

import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.ts';
import { auditEvents, markets, users } from '../db/schema.ts';

export interface AuditEventView {
  eventId: string;
  actorId: string | null;
  actor: string | null;
  action: string;
  targetId: string | null;
  targetType: 'market' | 'user' | null;
  targetLabel: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export async function getAuditEvents(limit = 500): Promise<AuditEventView[]> {
  const cap = Math.max(1, Math.min(Math.floor(limit), 1000));
  // Two self-joins on `users`: one for the actor, one in case the target is a user.
  const actor = alias(users, 'actor');
  const targetUser = alias(users, 'target_user');

  const rows = await db
    .select({
      eventId: auditEvents.eventId,
      actorId: auditEvents.actorId,
      actor: actor.username,
      action: auditEvents.action,
      targetId: auditEvents.targetId,
      marketTitle: markets.title,
      targetUsername: targetUser.username,
      payload: auditEvents.payload,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(actor, eq(auditEvents.actorId, actor.userId))
    .leftJoin(markets, eq(auditEvents.targetId, markets.marketId))
    .leftJoin(targetUser, eq(auditEvents.targetId, targetUser.userId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(cap);

  return rows.map((r) => {
    const targetType: 'market' | 'user' | null =
      r.marketTitle != null ? 'market' : r.targetUsername != null ? 'user' : null;
    return {
      eventId: r.eventId,
      actorId: r.actorId,
      actor: r.actor,
      action: r.action,
      targetId: r.targetId,
      targetType,
      targetLabel: r.marketTitle ?? r.targetUsername ?? null,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
