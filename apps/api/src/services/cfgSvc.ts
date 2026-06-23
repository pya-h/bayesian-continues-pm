// Adaptive-config admin service. Read the live adaptive parameters + their
// history for a market, and let an admin pin/override or disable the controller.
// The static baseline (`markets.cfg`) is never mutated here; admin control lives in
// `markets.cfg_state.control` and is applied on top of adaptation by
// `liveEngineConfig`. Pin/override semantics are **replace**, not deep-merge: a
// provided `pinned` (or `cfg`) object replaces the previous one, so `pinned: {}`
// clears all pins and `enabled:false` freezes the params at their current pinned /
// baseline values.

import type { EngineConfig } from '@bmm/core';
import type { AdaptiveControlDTO, AdaptiveControlInput } from '@bmm/shared';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { UserRow } from '../db/repos.ts';
import { marketCfgHistory, markets } from '../db/schema.ts';
import { liveEngineConfig, loadCfgState, packCfgState } from '../lib/adaptiveCfg.ts';
import { writeAudit } from '../lib/audit.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';

const CFG_HISTORY_LIMIT = 500;

type MarketRow = typeof markets.$inferSelect;

function baseParams(cfg: EngineConfig) {
  return { sigmaEps: cfg.sigmaEps, s0: cfg.s0, alpha: cfg.alpha, beta: cfg.beta };
}

async function requireMarket(marketId: string): Promise<MarketRow> {
  const rows = await db.select().from(markets).where(eq(markets.marketId, marketId));
  const m = rows[0];
  if (!m) throw new HttpError(404, 'Market not found');
  return m;
}

export async function getMarketCfg(marketId: string) {
  const m = await requireMarket(marketId);
  const base = m.cfg as unknown as EngineConfig;
  const live = liveEngineConfig(m);

  const history = await db
    .select()
    .from(marketCfgHistory)
    .where(eq(marketCfgHistory.marketId, marketId))
    .orderBy(desc(marketCfgHistory.createdAt))
    .limit(CFG_HISTORY_LIMIT);

  return {
    base: baseParams(base),
    initialSigma: m.initialSigma,
    control: live.control ?? {},
    source: live.source,
    state: live.state,
    adapted: {
      sigmaEps: live.adapted.sigmaEps,
      s0: live.adapted.s0,
      alpha: live.adapted.alpha,
      beta: live.adapted.beta,
      regime: live.adapted.regime,
      railHit: live.adapted.railHit,
      rails: live.adapted.rails,
    },
    live: baseParams(live.cfg),
    history: history.reverse(),
  };
}

export async function setMarketCfgControl(
  admin: UserRow,
  marketId: string,
  input: AdaptiveControlInput,
) {
  const m = await requireMarket(marketId);
  const { state, control } = loadCfgState(m);

  const next: AdaptiveControlDTO = { ...(control ?? {}) };
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.pinned !== undefined) next.pinned = input.pinned;
  if (input.cfg !== undefined) next.cfg = input.cfg;

  await db.transaction(async (tx) => {
    await tx
      .update(markets)
      .set({ cfgState: packCfgState(state, next), updatedAt: new Date() })
      .where(eq(markets.marketId, marketId));
    await writeAudit(
      {
        actorId: admin.userId,
        action: 'market_cfg_update',
        targetId: marketId,
        payload: { enabled: next.enabled, pinned: next.pinned, cfg: next.cfg },
      },
      tx,
    );
  });

  const updated = await getMarketCfg(marketId);
  // Notify any open admin cfg view (this admin or another) that control changed.
  publish(topics.market(marketId), {
    type: 'param_adapted',
    marketId,
    source: updated.source,
    sigmaEps: updated.live.sigmaEps,
    s0: updated.live.s0,
    railHit: updated.adapted.railHit,
  });
  return updated;
}
