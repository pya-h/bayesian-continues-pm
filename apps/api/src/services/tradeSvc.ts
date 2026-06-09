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
  GaussianBelief,
  type ReserveOpts,
  bayesUpdate,
  computeSpread,
  contractKey,
  evalBreakers,
  extractSignal,
  price,
  requiredReserve,
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
  const belief = new GaussianBelief(m.currentMu, m.currentSigma * m.currentSigma);
  const q = dto.q;
  const side: Side = q >= 0 ? 'buy' : 'sell';
  const key = contractKey(spec);

  const rows = await db.select().from(contracts).where(eq(contracts.marketId, marketId));
  const book = bookFromRows(rows);
  const mmShort = rows.find((r) => r.contractKey === key)?.mmShort ?? 0;

  const fair = price(spec, belief);
  const spread = computeSpread(spec, q, mmShort, belief, cfg);
  const execPrice = execPriceFor(side, fair, spread.total);
  const totalCost = round8(execPrice * q);

  const sig = extractSignal(spec, q, belief, cfg);
  const projected = bayesUpdate(belief, sig.signal, sig.weight, cfg);
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
    projectedBelief: { mu: round8(projected.mu), sigma: round8(projected.stddev()) },
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
      const belief = new GaussianBelief(m.currentMu, m.currentSigma * m.currentSigma);
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
      const execPrice = execPriceFor(side, fair, spread.total);

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
      const sig = extractSignal(spec, filledQ, belief, cfg);
      const newBelief = bayesUpdate(belief, sig.signal, sig.weight, cfg);
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
          beliefMuBefore: belief.mu,
          beliefSigmaBefore: sigmaBefore,
          beliefMuAfter: newBelief.mu,
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
        prevMu: belief.mu,
        prevSigma: sigmaBefore,
        newMu: newBelief.mu,
        newSigma: sigmaAfter,
        signalExtracted: sig.signal,
        signalWeight: sig.weight,
        triggerTradeId: tradeId,
      });

      await tx
        .update(markets)
        .set({
          currentMu: newBelief.mu,
          currentSigma: sigmaAfter,
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
        beliefBefore: { mu: round8(belief.mu), sigma: round8(sigmaBefore) },
        beliefAfter: { mu: round8(newBelief.mu), sigma: round8(sigmaAfter) },
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
  const fairAfter = priceAtBelief(spec, result.beliefAfter.mu, result.beliefAfter.sigma);
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

  await writeAudit({
    actorId: actor.userId,
    action: 'trade_execute',
    targetId: marketId,
    payload: {
      contractKey: key,
      side: result.side,
      q: result.filledQ,
      execPrice: result.execPrice,
    },
  });

  return result;
}

function priceAtBelief(spec: ContractSpec, mu: number, sigma: number): number {
  return price(spec, new GaussianBelief(mu, sigma * sigma));
}
