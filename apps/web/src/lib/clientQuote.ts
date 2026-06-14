// Client-side ESTIMATE of a server quote, for the interactive live-preview mode.
// The server quote has three moving parts: the fair value (closed-form E_p[f(θ)])
// the spread breakdown, and the exec price derived from the two. The client can
// reproduce MOST of these exactly from `@bmm/core` — only the **inventory** spread
// term needs the maker's per-contract short (book state the client doesn't have)
// so that one term is carried over from the last real server quote.
// `fair` = closed-form E_p[f(θ)] — recomputed every frame; exact for EVERY
// belief kind (the caller passes the market's real `BeliefModel` via
// `beliefFromView`, so a multi-modal / fat-tailed market previews against its
// true belief, not a Gaussian stand-in).
// spread `base`, `adverseSelection`, `volatility` — pure functions of
// (spec, belief, cfg, q); recomputed live via `computeSpread` (the `mmShort=0`
// we pass only feeds the inventory term, which we then replace).
// spread `inventory` — needs the book → carried from the last server quote.
// `execPrice` / `totalCost` follow the engine's formulas: ask = fair + spread
// bid = fair − spread, each clamped to the contract's payoff bounds
// totalCost = execPrice · signedQ.
// The result updates interactively with no network round-trip; only the inventory
// term lags (it moves slowly, and only on other traders' fills).

import type { BeliefModel, EngineConfig, SpreadBreakdown } from '@bmm/core';
import { computeSpread, payoffBounds } from '@bmm/core';
import type { ContractSpec } from './types.ts';

export interface EstimatedQuote {
  fair: number;
  spread: SpreadBreakdown;
  execPrice: number;
  totalCost: number;
}

export function estimateQuote(args: {
  spec: ContractSpec;
  signedQ: number;
  belief: BeliefModel;
  cfg: EngineConfig;
  // Inventory spread term from the last server quote (book-dependent; can't be
  // recomputed client-side without the maker's per-contract short).
  serverInventory: number;
}): EstimatedQuote {
  const { spec, signedQ, belief, cfg, serverInventory } = args;
  // base / adverse-selection / volatility are exact functions of (spec, belief
  // cfg, q); mmShort=0 only feeds the inventory term, which we replace with the
  // server's last value (the one term that genuinely needs the maker's book).
  const raw = computeSpread(spec, signedQ, 0, belief, cfg);
  const inventory = serverInventory;
  const total = raw.base + inventory + raw.adverseSelection + raw.volatility;
  const spread: SpreadBreakdown = { ...raw, inventory, total };
  const fair = raw.fair;
  // Clamp to payoff bounds, mirroring the server's execPriceFor
  // a bounded contract's ask never exceeds its max payout, bid never goes below 0.
  const b = payoffBounds(spec);
  const execPrice =
    signedQ >= 0
      ? b.bounded && b.max != null
        ? Math.min(fair + total, b.max)
        : fair + total
      : Math.max(b.bounded && b.min != null ? b.min : 0, fair - total);
  const totalCost = execPrice * signedQ;
  return { fair, spread, execPrice, totalCost };
}
