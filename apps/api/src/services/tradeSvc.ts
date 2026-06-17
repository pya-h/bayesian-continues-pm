// TradeSvc — quoting and trade execution.
// `quote` is read-only (no lock): fair → spread → exec price → projected belief
// and reserve + the max feasible fill, so the chart can preview before trading.
// `executeTrade` is serialized per market (in-process lock + `FOR UPDATE` on the
// market and trader rows) and atomic (one DB transaction). Order of operations
// fair → spread → exec price → slippage → balance/position checks
// → tentative apply (mmShort, belief, position, cash) → recompute reserve →
// solvency gate → commit → emit WS events. Partial fills shrink
// the size to the largest amount the gate allows.

import {
  type BookEntry,
  type ContractSpec,
  type EngineConfig,
  type ReserveOpts,
  computeSpread,
  contractKey,
  evalBreakers,
  price,
  requiredReserve,
  tradeSignal,
  updateBeliefForTrade,
  validateContract,
  withMmShort,
} from '@bmm/core';
import type { QuoteDTO, TradeDTO } from '@bmm/shared';
import { TransactionKind, round8 } from '@bmm/shared';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.ts';
import { db } from '../db/client.ts';
import { type UserRow, marketRepo } from '../db/repos.ts';
import { beliefUpdates, contracts, markets, positions, trades, users } from '../db/schema.ts';
import { writeAudit } from '../lib/audit.ts';
import { beliefPersistFields, loadBelief, mixtureOpsFor } from '../lib/belief.ts';
import { paramsFromSpec, specFromRow } from '../lib/contract.ts';
import { HttpError } from '../lib/errors.ts';
import { publish, topics } from '../realtime.ts';
import { recordTx } from './ledgerSvc.ts';
import { withMarketLock } from './marketQueue.ts';
import { type Side, applyFill, execPriceFor, solveFill } from './tradeMath.ts';

const OPEN_MARGIN = 1.2;

function reserveOptsFor(cfg: EngineConfig): ReserveOpts {
  return { alpha: cfg.reserveAlpha, samples: config.reserve.mcSamples };
}

function bookFromRows(
  rows: { type: ContractRowType; params: Record<string, number>; mmShort: number }[],
): BookEntry[] {
  return rows.map((r) => ({ spec: specFromRow(r.type, r.params), mmShort: r.mmShort }));
}
type ContractRowType = typeof contracts.$inferSelect.type;

export interface QuoteResult {
  side: Side;
  q: number;
  fair: number;
  spread: {
    base: number;
    inventory: number;
    adverseSelection: number;
    volatility: number;
    total: number;
  };
  execPrice: number;
  totalCost: number; // signed: buy > 0 (pays), sell < 0 (receives)
  projectedBelief: { mu: number; sigma: number };
  projectedReserve: number;
  maxExecutable: number; // |size| feasible right now
}

export async function quote(marketId: string, dto: QuoteDTO): Promise<QuoteResult> {
  const m = await marketRepo.byId(marketId);
  if (!m) throw new HttpError(404, 'Market not found');

  const spec = validateContract(dto.spec);
  const cfg = m.cfg as unknown as EngineConfig;
  const belief = loadBelief(m);
  const q = dto.q;
  const side: Side = q >= 0 ? 'buy' : 'sell';
  const key = contractKey(spec);

  const rows = await db.select().from(contracts).where(eq(contracts.marketId, marketId));
  const book = bookFromRows(rows);
  const mmShort = rows.find((r) => r.contractKey === key)?.mmShort ?? 0;

  const fair = price(spec, belief);
  const spread = computeSpread(spec, q, mmShort, belief, cfg);
  const execPrice = execPriceFor(side, fair, spread.total, spec);
  const totalCost = round8(execPrice * q);

  const projected = updateBeliefForTrade(spec, q, belief, cfg, m.model, mixtureOpsFor(m));
  const nextBook = withMmShort(book, spec, key, contractKey, mmShort + q);
  const reserveOpts = reserveOptsFor(cfg);
  // Preview the live reserve mark at the POST-update belief — the same value
  // executeTrade stores as reserveRequired (the gate itself sizes at the
  // pre-update belief, but the displayed projection should match the booked mark).
  const projectedReserve = round8(requiredReserve(nextBook, projected, reserveOpts));

  const { fillSize } = solveFill({
    spec,
    side,
    targetSize: Math.abs(q),
    mmShort,
    book,
    belief,
    cfg,
    fair,
    cash: m.cash,
    balance: Number.POSITIVE_INFINITY, // quote is balance-agnostic; execute enforces it
    isInfinite: true,
    reserveOpts,
    openMargin: OPEN_MARGIN,
  });

  return {
    side,
    q,
    fair: round8(fair),
    spread: {
      base: round8(spread.base),
      inventory: round8(spread.inventory),
      adverseSelection: round8(spread.adverseSelection),
      volatility: round8(spread.volatility),
      total: round8(spread.total),
    },
    execPrice: round8(execPrice),
    totalCost,
    projectedBelief: { mu: round8(projected.mean()), sigma: round8(projected.stddev()) },
    projectedReserve,
    maxExecutable: round8(fillSize),
  };
}

export interface FillResult {
  tradeId: string;
  contractId: string;
  side: Side;
  requestedQ: number;
  filledQ: number; // signed
  partial: boolean;
  fair: number;
  execPrice: number;
  spreadTotal: number;
  totalCost: number; // signed
  beliefBefore: { mu: number; sigma: number };
  beliefAfter: { mu: number; sigma: number };
  fairAfter: number; // fair price of THIS contract at the post-update belief
  reserveRequired: number;
  cash: number;
  balance: number | null; // null for infinite traders
  position: { quantity: number; avgEntryPrice: number; realizedPnl: number };
}

export async function executeTrade(
  actor: UserRow,
  marketId: string,
  dto: TradeDTO,
): Promise<FillResult> {
  const spec = validateContract(dto.spec);
  const key = contractKey(spec);
  const q = dto.q;
  const side: Side = q >= 0 ? 'buy' : 'sell';

  let sigma0 = 0; // genesis σ₀, captured inside the txn for the circuit breakers
  const result = await withMarketLock(marketId, () =>
    db.transaction(async (tx): Promise<FillResult> => {
      const mrows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, marketId))
        .for('update');
      const m = mrows[0];
      if (!m) throw new HttpError(404, 'Market not found');
      if (m.status !== 'OPEN') throw new HttpError(409, 'Market is not open for trading');
      sigma0 = m.initialSigma;

      const cfg = m.cfg as unknown as EngineConfig;
      const reserveOpts = reserveOptsFor(cfg);
      const belief = loadBelief(m);
      const fair = price(spec, belief);

      const contractRows = await tx
        .select()
        .from(contracts)
        .where(eq(contracts.marketId, marketId));
      const book = bookFromRows(contractRows);
      const existing = contractRows.find((r) => r.contractKey === key);
      const mmShort = existing?.mmShort ?? 0;

      const urows = await tx
        .select()
        .from(users)
        .where(eq(users.userId, actor.userId))
        .for('update');
      const u = urows[0];
      if (!u) throw new HttpError(404, 'User not found');

      // Existing position (long-only).
      let pos = { quantity: 0, avgEntryPrice: 0, realizedPnl: 0, peakUnrealized: 0 };
      if (existing) {
        const prows = await tx
          .select()
          .from(positions)
          .where(and(eq(positions.userId, u.userId), eq(positions.contractId, existing.contractId)))
          .limit(1);
        if (prows[0]) {
          pos = {
            quantity: prows[0].quantity,
            avgEntryPrice: prows[0].avgEntryPrice,
            realizedPnl: prows[0].realizedPnl,
            peakUnrealized: prows[0].peakUnrealized,
          };
        }
      }

      // Sell only what you hold.
      if (side === 'sell') {
        if (pos.quantity <= 0) throw new HttpError(400, 'No position to sell');
        if (Math.abs(q) > pos.quantity + 1e-9) {
          throw new HttpError(400, `Cannot sell ${Math.abs(q)}; you hold ${pos.quantity}`);
        }
      }

      // Size the fill (partial when the full size breaches the gate / balance).
      const { fillSize, reserveBefore } = solveFill({
        spec,
        side,
        targetSize: Math.abs(q),
        mmShort,
        book,
        belief,
        cfg,
        fair,
        cash: m.cash,
        balance: u.balance,
        isInfinite: u.isInfinite,
        reserveOpts,
        openMargin: OPEN_MARGIN,
      });
      if (fillSize < 1e-6) {
        throw new HttpError(
          409,
          'Trade rejected: insufficient capacity or balance (solvency gate)',
        );
      }
      const filledQ = round8(side === 'buy' ? fillSize : -fillSize);

      const spread = computeSpread(spec, filledQ, mmShort, belief, cfg);
      const execPrice = execPriceFor(side, fair, spread.total, spec);

      // Slippage bound: buy ⇒ exec ≤ maxPrice; sell ⇒ exec ≥ maxPrice.
      if (dto.maxPrice !== undefined) {
        if (side === 'buy' && execPrice > dto.maxPrice + 1e-9) {
          throw new HttpError(409, `Slippage: exec ${round8(execPrice)} above max ${dto.maxPrice}`);
        }
        if (side === 'sell' && execPrice < dto.maxPrice - 1e-9) {
          throw new HttpError(409, `Slippage: exec ${round8(execPrice)} below min ${dto.maxPrice}`);
        }
      }

      // Tentative apply: belief, inventory, cash.
      // `sig` feeds the belief-update audit row (signalExtracted/Weight) and mirrors
      // what updateBeliefForTrade actually applies — for a Gen·basis bell that's the
      // placement (center + signed strength), otherwise the standard extracted signal.
      const sig = tradeSignal(spec, filledQ, belief, cfg, m.model);
      const newBelief = updateBeliefForTrade(spec, filledQ, belief, cfg, m.model, mixtureOpsFor(m));
      const newMmShort = round8(mmShort + filledQ);
      const newBook = withMmShort(book, spec, key, contractKey, newMmShort);

      const totalCost = round8(execPrice * filledQ); // signed: buy > 0
      const cashAfter = round8(m.cash + totalCost);

      // Acceptance gate — re-derived on the SAME (pre-update) belief solveFill
      // sized against, so sizing and acceptance can't disagree. A buy's own
      // premium inflow is excluded from the backing (effectiveCash).
      const reserveSizing = requiredReserve(newBook, belief, reserveOpts);
      const margin = reserveSizing > reserveBefore ? OPEN_MARGIN : 1;
      const effectiveCash = round8(m.cash + Math.min(0, totalCost));
      if (effectiveCash + 1e-6 < margin * reserveSizing) {
        throw new HttpError(409, 'Trade rejected: solvency gate');
      }
      // Stored reserve mark uses the POST-update belief (the live exposure).
      const reserveAfter = round8(requiredReserve(newBook, newBelief, reserveOpts));
      if (side === 'buy' && !u.isInfinite && u.balance + 1e-9 < totalCost) {
        throw new HttpError(400, 'Insufficient balance');
      }

      // Commit ---
      let contractId = existing?.contractId;
      if (existing) {
        await tx
          .update(contracts)
          .set({ mmShort: newMmShort })
          .where(eq(contracts.contractId, existing.contractId));
      } else {
        const ins = await tx
          .insert(contracts)
          .values({
            marketId,
            contractKey: key,
            type: spec.type,
            params: paramsFromSpec(spec),
            mmShort: newMmShort,
          })
          .returning();
        contractId = (ins[0] as { contractId: string }).contractId;
      }
      if (!contractId) throw new HttpError(500, 'Failed to resolve contract id');

      const sigmaBefore = belief.stddev();
      const sigmaAfter = newBelief.stddev();
      const tradeIns = await tx
        .insert(trades)
        .values({
          marketId,
          userId: u.userId,
          contractId,
          side,
          quantity: filledQ,
          execPrice,
          fairPrice: round8(fair),
          spreadTotal: round8(spread.total),
          totalCost,
          beliefMuBefore: belief.mean(),
          beliefSigmaBefore: sigmaBefore,
          beliefMuAfter: newBelief.mean(),
          beliefSigmaAfter: sigmaAfter,
        })
        .returning();
      const tradeId = (tradeIns[0] as { tradeId: string }).tradeId;

      // Position (average-entry).
      const filled = applyFill(
        { quantity: pos.quantity, avgEntryPrice: pos.avgEntryPrice, realizedPnl: pos.realizedPnl },
        filledQ,
        execPrice,
      );
      const markAfter = price(spec, newBelief);
      const unrealized = round8(filled.quantity * (markAfter - filled.avgEntryPrice));
      const peakUnrealized = Math.max(pos.peakUnrealized, unrealized);
      await tx
        .insert(positions)
        .values({
          userId: u.userId,
          contractId,
          marketId,
          quantity: filled.quantity,
          avgEntryPrice: filled.avgEntryPrice,
          realizedPnl: filled.realizedPnl,
          peakUnrealized,
        })
        .onConflictDoUpdate({
          target: [positions.userId, positions.contractId],
          set: {
            quantity: filled.quantity,
            avgEntryPrice: filled.avgEntryPrice,
            realizedPnl: filled.realizedPnl,
            peakUnrealized,
            updatedAt: new Date(),
          },
        });

      await tx.insert(beliefUpdates).values({
        marketId,
        prevMu: belief.mean(),
        prevSigma: sigmaBefore,
        newMu: newBelief.mean(),
        newSigma: sigmaAfter,
        signalExtracted: sig.signal,
        signalWeight: sig.weight,
        triggerTradeId: tradeId,
      });

      await tx
        .update(markets)
        .set({
          ...beliefPersistFields(newBelief),
          cash: cashAfter,
          reserveRequired: reserveAfter,
          updatedAt: new Date(),
        })
        .where(eq(markets.marketId, marketId));

      let newBalance: number | null = null;
      if (!u.isInfinite) {
        newBalance = round8(u.balance - totalCost); // buy debits, sell credits
        await tx
          .update(users)
          .set({ balance: newBalance, updatedAt: new Date() })
          .where(eq(users.userId, u.userId));
      }

      // Ledger: the trade's effect on the trader's wallet is −totalCost (a buy
      // debits the premium, a sell credits it). marketId + tradeId tie it back.
      await recordTx(tx, {
        userId: u.userId,
        kind: side === 'buy' ? TransactionKind.TRADE_BUY : TransactionKind.TRADE_SELL,
        amount: round8(-totalCost),
        balanceAfter: newBalance,
        marketId,
        refType: 'trade',
        refId: tradeId,
        metadata: {
          side,
          quantity: filledQ,
          execPrice: round8(execPrice),
          contractKey: key,
          contractType: spec.type,
        },
      });

      // Audit inside the tx: a post-commit insert failure would 5xx an executed
      // trade, and (with no idempotency key on the route) invite a double-trade retry.
      await writeAudit(
        {
          actorId: actor.userId,
          action: 'trade_execute',
          targetId: marketId,
          payload: { contractKey: key, side, q: filledQ, execPrice: round8(execPrice) },
        },
        tx,
      );

      return {
        tradeId,
        contractId,
        side,
        requestedQ: q,
        filledQ,
        partial: Math.abs(filledQ) + 1e-9 < Math.abs(q),
        fair: round8(fair),
        execPrice: round8(execPrice),
        spreadTotal: round8(spread.total),
        totalCost,
        beliefBefore: { mu: round8(belief.mean()), sigma: round8(sigmaBefore) },
        beliefAfter: { mu: round8(newBelief.mean()), sigma: round8(sigmaAfter) },
        fairAfter: round8(markAfter),
        reserveRequired: reserveAfter,
        cash: cashAfter,
        balance: newBalance,
        position: {
          quantity: filled.quantity,
          avgEntryPrice: filled.avgEntryPrice,
          realizedPnl: filled.realizedPnl,
        },
      };
    }),
  );

  // Side effects (after commit) ---
  const fairAfter = result.fairAfter; // true post-update fair (mixture-correct)
  publish(topics.market(marketId), {
    type: 'trade_executed',
    tradeId: result.tradeId,
    side: result.side,
    q: result.filledQ,
    execPrice: result.execPrice,
    fair: result.fair,
  });
  publish(topics.market(marketId), {
    type: 'belief_update',
    mu: result.beliefAfter.mu,
    sigma: result.beliefAfter.sigma,
  });
  publish(topics.market(marketId), {
    type: 'price_change',
    contractKey: key,
    fair: round8(fairAfter),
  });
  publish(topics.market(marketId), {
    type: 'reserve_update',
    reserveRequired: result.reserveRequired,
    cash: result.cash,
  });
  publish(topics.user(actor.userId), {
    type: 'trade_executed',
    marketId,
    tradeId: result.tradeId,
  });

  // Circuit breakers — evaluate post-commit and broadcast any
  // alerts to the system topic so admins see them live. v1 alerts only (does not
  // auto-suspend); the action field tells the admin what recommends.
  const priceMovePct =
    Math.abs(result.fair) > 1e-9 ? (fairAfter - result.fair) / Math.abs(result.fair) : 0;
  const alerts = evalBreakers({
    sigma: result.beliefAfter.sigma,
    sigma0,
    priceMovePct,
    cash: result.cash,
    reserve: result.reserveRequired,
  });
  for (const alert of alerts) {
    publish(topics.system, {
      type: 'system:alert',
      marketId,
      ...alert,
      at: new Date().toISOString(),
    });
  }

  return result;
}

export interface SellAllFill {
  tradeId: string;
  contractId: string;
  contractKey: string;
  spec: ContractSpec;
  quantity: number; // |size| closed (positive)
  execPrice: number;
  proceeds: number; // credit to the trader (positive)
  realizedPnl: number;
  partial: boolean;
}

export interface SellAllResult {
  marketId: string;
  count: number; // positions closed
  fills: SellAllFill[];
  totalProceeds: number; // sum of credits to the trader
  totalRealizedPnl: number;
  cash: number; // pool cash after
  reserveRequired: number;
  balance: number | null; // trader balance after (null for infinite)
  priceMovePct: number;
  beliefAfter: { mu: number; sigma: number };
}

// Liquidate every position the trader holds in one market — atomically. Runs in a
// single market lock + DB transaction; positions are closed sequentially against
// the *evolving* belief/inventory/cash (exactly as N individual sells would move
// the market), but committed together with one final market + balance write. Each
// close still records its own trade, belief update, position upsert and ledger row
// so the per-contract audit trail is identical to selling one at a time.
export async function sellAllPositions(actor: UserRow, marketId: string): Promise<SellAllResult> {
  let sigma0 = 0;
  const affected = new Map<string, { spec: ContractSpec; fair: number }>();

  const result = await withMarketLock(marketId, () =>
    db.transaction(async (tx): Promise<SellAllResult> => {
      const mrows = await tx
        .select()
        .from(markets)
        .where(eq(markets.marketId, marketId))
        .for('update');
      const m = mrows[0];
      if (!m) throw new HttpError(404, 'Market not found');
      if (m.status !== 'OPEN') throw new HttpError(409, 'Market is not open for trading');
      sigma0 = m.initialSigma;

      const cfg = m.cfg as unknown as EngineConfig;
      const reserveOpts = reserveOptsFor(cfg);

      const urows = await tx
        .select()
        .from(users)
        .where(eq(users.userId, actor.userId))
        .for('update');
      const u = urows[0];
      if (!u) throw new HttpError(404, 'User not found');

      // Every contract in the market, with its spec + initial mmShort — the full
      // book the reserve is computed over. mmShort is evolved per close below.
      const liveContracts = (
        await tx.select().from(contracts).where(eq(contracts.marketId, marketId))
      ).map((r) => ({
        key: r.contractKey,
        spec: specFromRow(r.type, r.params as Record<string, number>),
        mmShort: r.mmShort,
      }));

      // The trader's open positions in this market, joined to their contract.
      const posRows = await tx
        .select({
          contractId: positions.contractId,
          quantity: positions.quantity,
          avgEntryPrice: positions.avgEntryPrice,
          realizedPnl: positions.realizedPnl,
          peakUnrealized: positions.peakUnrealized,
          contractKey: contracts.contractKey,
          type: contracts.type,
          params: contracts.params,
        })
        .from(positions)
        .innerJoin(contracts, eq(positions.contractId, contracts.contractId))
        .where(and(eq(positions.userId, u.userId), eq(positions.marketId, marketId)));

      // Deterministic order; only positions with a real long to close.
      const toClose = posRows
        .filter((p) => p.quantity > 1e-9)
        .sort((a, b) => a.contractKey.localeCompare(b.contractKey));
      if (toClose.length === 0) throw new HttpError(400, 'No open positions to sell');

      // Live market state, evolved per close.
      let liveBelief = loadBelief(m);
      let liveCash = m.cash;
      let runningBalance = u.balance;
      let reserveAfter = m.reserveRequired;
      const mmShortByKey = new Map(liveContracts.map((c) => [c.key, c.mmShort]));

      // Build the full book from the live mmShort map (every contract in the market).
      const buildBook = (): BookEntry[] =>
        liveContracts.map((c) => ({ spec: c.spec, mmShort: mmShortByKey.get(c.key) ?? 0 }));

      const fills: SellAllFill[] = [];
      let totalProceeds = 0;
      let totalRealizedPnl = 0;
      // Largest signed relative fair move across the closed contracts — feeds the
      // rapid-move breaker post-commit (passing 0 made it blind to sell-alls).
      let maxPriceMovePct = 0;

      for (const p of toClose) {
        const spec = specFromRow(p.type, p.params as Record<string, number>);
        const key = p.contractKey;
        const belief = liveBelief;
        const fair = price(spec, belief);
        const mmShort = mmShortByKey.get(key) ?? 0;
        const book = buildBook();

        const { fillSize } = solveFill({
          spec,
          side: 'sell',
          targetSize: p.quantity,
          mmShort,
          book,
          belief,
          cfg,
          fair,
          cash: liveCash,
          balance: u.balance,
          isInfinite: u.isInfinite,
          reserveOpts,
          openMargin: OPEN_MARGIN,
        });
        if (fillSize < 1e-6) continue; // can't reduce risk further; leave it open

        const filledQ = round8(-fillSize);
        const spread = computeSpread(spec, filledQ, mmShort, belief, cfg);
        const execPrice = execPriceFor('sell', fair, spread.total, spec);

        const sig = tradeSignal(spec, filledQ, belief, cfg, m.model);
        const newBelief = updateBeliefForTrade(
          spec,
          filledQ,
          belief,
          cfg,
          m.model,
          mixtureOpsFor(m),
        );
        const newMmShort = round8(mmShort + filledQ);
        mmShortByKey.set(key, newMmShort);
        const newBook = buildBook();

        const totalCost = round8(execPrice * filledQ); // negative (credit)
        liveCash = round8(liveCash + totalCost);

        const sigmaBefore = belief.stddev();
        const sigmaAfter = newBelief.stddev();
        reserveAfter = round8(requiredReserve(newBook, newBelief, reserveOpts));

        await tx
          .update(contracts)
          .set({ mmShort: newMmShort })
          .where(eq(contracts.contractId, p.contractId));

        const tradeIns = await tx
          .insert(trades)
          .values({
            marketId,
            userId: u.userId,
            contractId: p.contractId,
            side: 'sell',
            quantity: filledQ,
            execPrice,
            fairPrice: round8(fair),
            spreadTotal: round8(spread.total),
            totalCost,
            beliefMuBefore: belief.mean(),
            beliefSigmaBefore: sigmaBefore,
            beliefMuAfter: newBelief.mean(),
            beliefSigmaAfter: sigmaAfter,
          })
          .returning();
        const tradeId = (tradeIns[0] as { tradeId: string }).tradeId;

        const filled = applyFill(
          { quantity: p.quantity, avgEntryPrice: p.avgEntryPrice, realizedPnl: p.realizedPnl },
          filledQ,
          execPrice,
        );
        const markAfter = price(spec, newBelief);
        const unrealized = round8(filled.quantity * (markAfter - filled.avgEntryPrice));
        const peakUnrealized = Math.max(p.peakUnrealized, unrealized);
        await tx
          .update(positions)
          .set({
            quantity: filled.quantity,
            avgEntryPrice: filled.avgEntryPrice,
            realizedPnl: filled.realizedPnl,
            peakUnrealized,
            updatedAt: new Date(),
          })
          .where(and(eq(positions.userId, u.userId), eq(positions.contractId, p.contractId)));

        await tx.insert(beliefUpdates).values({
          marketId,
          prevMu: belief.mean(),
          prevSigma: sigmaBefore,
          newMu: newBelief.mean(),
          newSigma: sigmaAfter,
          signalExtracted: sig.signal,
          signalWeight: sig.weight,
          triggerTradeId: tradeId,
        });

        if (!u.isInfinite) runningBalance = round8(runningBalance - totalCost); // credit

        await recordTx(tx, {
          userId: u.userId,
          kind: TransactionKind.TRADE_SELL,
          amount: round8(-totalCost), // + credit
          balanceAfter: u.isInfinite ? null : runningBalance,
          marketId,
          refType: 'trade',
          refId: tradeId,
          metadata: {
            side: 'sell',
            quantity: filledQ,
            execPrice: round8(execPrice),
            contractKey: key,
            contractType: spec.type,
            sellAll: true,
          },
        });

        const closedRealized = round8(filled.realizedPnl - p.realizedPnl);
        const proceeds = round8(-totalCost);
        totalProceeds = round8(totalProceeds + proceeds);
        totalRealizedPnl = round8(totalRealizedPnl + closedRealized);
        if (Math.abs(fair) > 1e-9) {
          const move = (markAfter - fair) / Math.abs(fair);
          if (Math.abs(move) > Math.abs(maxPriceMovePct)) maxPriceMovePct = move;
        }
        liveBelief = newBelief;

        // Provisional fair (this contract's post-close belief); re-marked at the
        // final belief after the loop. Reuses markAfter to avoid a duplicate price.
        affected.set(key, { spec, fair: markAfter });
        fills.push({
          tradeId,
          contractId: p.contractId,
          contractKey: key,
          spec,
          quantity: round8(fillSize),
          execPrice: round8(execPrice),
          proceeds,
          realizedPnl: closedRealized,
          partial: fillSize + 1e-9 < p.quantity,
        });
      }

      if (fills.length === 0) {
        throw new HttpError(409, 'Trade rejected: positions could not be closed (solvency gate)');
      }

      // Re-mark every touched contract at the FINAL belief. During the loop each
      // contract's fair was snapshotted at the belief right after its own close
      // but the post-commit price_change broadcast must agree with the single
      // committed belief_update — otherwise a 3-position sell-all emits fairs from
      // intermediate beliefs.
      for (const [key, v] of affected) {
        affected.set(key, { spec: v.spec, fair: price(v.spec, liveBelief) });
      }

      await tx
        .update(markets)
        .set({
          ...beliefPersistFields(liveBelief),
          cash: liveCash,
          reserveRequired: reserveAfter,
          updatedAt: new Date(),
        })
        .where(eq(markets.marketId, marketId));

      let newBalance: number | null = null;
      if (!u.isInfinite) {
        newBalance = runningBalance;
        await tx
          .update(users)
          .set({ balance: newBalance, updatedAt: new Date() })
          .where(eq(users.userId, u.userId));
      }

      // Audit inside the tx (same reasoning as the single-trade path).
      await writeAudit(
        {
          actorId: actor.userId,
          action: 'trade_sell_all',
          targetId: marketId,
          payload: { count: fills.length, totalProceeds },
        },
        tx,
      );

      return {
        marketId,
        count: fills.length,
        fills,
        totalProceeds,
        totalRealizedPnl,
        cash: liveCash,
        reserveRequired: reserveAfter,
        balance: newBalance,
        priceMovePct: maxPriceMovePct,
        beliefAfter: { mu: round8(liveBelief.mean()), sigma: round8(liveBelief.stddev()) },
      };
    }),
  );

  // Side effects (after commit) ---
  publish(topics.market(marketId), {
    type: 'belief_update',
    mu: result.beliefAfter.mu,
    sigma: result.beliefAfter.sigma,
  });
  for (const [key, { fair }] of affected) {
    publish(topics.market(marketId), {
      type: 'price_change',
      contractKey: key,
      fair: round8(fair),
    });
  }
  publish(topics.market(marketId), {
    type: 'reserve_update',
    reserveRequired: result.reserveRequired,
    cash: result.cash,
  });
  publish(topics.user(actor.userId), { type: 'trade_executed', marketId, sellAll: true });

  const alerts = evalBreakers({
    sigma: result.beliefAfter.sigma,
    sigma0,
    priceMovePct: result.priceMovePct,
    cash: result.cash,
    reserve: result.reserveRequired,
  });
  for (const alert of alerts) {
    publish(topics.system, {
      type: 'system:alert',
      marketId,
      ...alert,
      at: new Date().toISOString(),
    });
  }

  return result;
}
