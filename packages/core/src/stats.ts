// Statistics — payout-distribution stats for a position under the current belief.
// Closed-form where available (expected payout, variance, bounded max)
// sampled (seeded) for distribution stats (P(profit), percentiles, VaR/CVaR).
// Market-level aggregates (volume, spread income, …) live in the API's StatsSvc
// core only knows the math of a single position's payout under a belief.

import { payoff, payoffBounds } from './contracts.ts';
import { GaussianBelief } from './gaussian.ts';
import type { MixtureBelief } from './mixture.ts';
import { Rng } from './numerics.ts';
import { price, priceGaussianPayoff } from './pricing.ts';
import { expectF } from './pricing.ts';
import { StudentTBelief, studentTCdfStd } from './student_t.ts';
import type { BeliefModel, ContractSpec } from './types.ts';

export interface PositionInput {
  spec: ContractSpec;
  quantity: number; // signed; v1 ≥ 0 for longs
  costBasis: number; // total paid to acquire (premium); PnL = payout − costBasis
}

export interface PositionStats {
  fairPrice: number; // per-unit fair value
  expectedPayout: number; // E[q·f]
  expectedPnl: number; // E[q·f] − costBasis
  payoutStd: number; // sd(q·f)
  maxPayout: number;
  minPayout: number;
  maxIsP99: boolean;
  pProfit: number; // P(q·f − costBasis > 0)
  var95: number; // 95% VaR of PnL (a loss, ≤ 0 sign: reported as the 5th pctile PnL)
  cvar95: number; // mean PnL in the worst 5%
  breakevenTheta: number | null;
}

// E[f(θ)²] — closed-form where possible, else numerical.
export function secondMoment(spec: ContractSpec, belief: BeliefModel): number {
  // Kind-independent shortcuts first: f ∈ {0,1} ⇒ f² = f (and price is exact for
  // every supported kind), and E[θ²] is just mean² + variance. Routing these through
  // quadrature put the jump inside a Simpson cell (~6e-4 error on mixtures).
  switch (spec.type) {
    case 'BINARY_CALL':
    case 'BINARY_PUT':
    case 'SPREAD':
      return price(spec, belief);
    case 'LINEAR':
      return belief.mean() ** 2 + belief.variance();
    default:
      break;
  }
  if (belief.kind === 'mixture') {
    // Per component: exact for the GAUSSIAN payoff, and CALL/PUT quadrature gets a
    // ±10σ_k window around EACH mode — a far low-weight mode contributes ~√π·d to the
    // TOTAL σ, so a single total-σ window can miss it entirely (π ≲ 1% ⇒ 100% error).
    const m = belief as MixtureBelief;
    let sum = 0;
    for (const c of m.components) {
      sum += c.pi * secondMoment(spec, new GaussianBelief(c.mu, c.sigma2));
    }
    return sum;
  }
  if (belief.kind === 'gaussian' && spec.type === 'GAUSSIAN') {
    // f² = exp(-(θ-c)²/w²) = gaussian payoff with width w/√2
    const g = belief as GaussianBelief;
    return priceGaussianPayoff(spec.center as number, (spec.width as number) / Math.SQRT2, g.mu, g.sigma2);
  }
  if (belief.kind === 'student_t' && (spec.type === 'CALL' || spec.type === 'PUT')) {
    // (θ−K)±² grows quadratically into a polynomial tail — any finite quadrature
    // window truncates real mass; use the truncated-moment closed form instead.
    return studentTKinkSecondMoment(spec, belief as StudentTBelief);
  }
  return expectF((t) => payoff(spec, t) ** 2, belief);
}

// E[((X−K)+)²] under Student-t, exactly.
// With d=(K−μ)/s and standard-t partial moments over [d, ∞)
// I₀ = 1−F_ν(d), I₁ = f_ν(d)·(ν+d²)/(ν−1)
// I₂ = d·I₁ + (ν/(ν−2))·(1−F_{ν−2}(d·√((ν−2)/ν))) [by parts: t²f_ν ties to F_{ν−2}]
// then E[((X−K)+)²] = s²·(I₂ − 2d·I₁ + d²·I₀). PUT follows from
// (K−X)+² = (X−K)² − (X−K)+² and E[(X−K)²] = Var + (μ−K)².
function studentTKinkSecondMoment(spec: ContractSpec, t: StudentTBelief): number {
  const K = spec.strike as number;
  const s = Math.sqrt(t.scale2);
  const d = (K - t.mu) / s;
  const fd = s * t.pdf(K); // standard-t pdf at d
  const i0 = 1 - t.cdf(K);
  const i1 = (fd * (t.nu + d * d)) / (t.nu - 1);
  const i2 = d * i1 + (t.nu / (t.nu - 2)) * (1 - studentTCdfStd(t.nu - 2, d * Math.sqrt((t.nu - 2) / t.nu)));
  const callSq = Math.max(0, t.scale2 * (i2 - 2 * d * i1 + d * d * i0));
  if (spec.type === 'CALL') return callSq;
  return Math.max(0, t.variance() + (t.mu - K) ** 2 - callSq);
}

function breakeven(spec: ContractSpec, quantity: number, costBasis: number): number | null {
  if (quantity === 0) return null;
  const perUnit = costBasis / quantity; // target payoff per unit
  switch (spec.type) {
    case 'LINEAR':
      return perUnit;
    case 'CALL':
      return perUnit <= 0 ? null : (spec.strike as number) + perUnit;
    case 'PUT':
      return perUnit <= 0 ? null : (spec.strike as number) - perUnit;
    default:
      return null; // bounded payoffs: breakeven not a single clean threshold
  }
}

export interface StatsOpts {
  samples?: number;
  seed?: number;
}

export function positionStats(
  pos: PositionInput,
  belief: BeliefModel,
  opts: StatsOpts = {},
): PositionStats {
  const { spec, quantity, costBasis } = pos;
  const fair = price(spec, belief);
  const expectedPayout = quantity * fair;

  const m2 = secondMoment(spec, belief);
  const payoutVar = quantity * quantity * Math.max(0, m2 - fair * fair);
  const payoutStd = Math.sqrt(payoutVar);

  // Bounded extrema (closed form) vs unbounded (p99 from samples).
  const bounds = payoffBounds(spec);
  const n = opts.samples ?? 20_000;
  const rng = new Rng(opts.seed ?? 0x53544154); // 'STAT'
  const draws = belief.sample(n, rng);
  const pnls = new Float64Array(n);
  let profitCount = 0;
  for (let i = 0; i < n; i++) {
    const pay = quantity * payoff(spec, draws[i] as number);
    const pnl = pay - costBasis;
    pnls[i] = pnl;
    if (pnl > 0) profitCount++;
  }
  pnls.sort();

  const pctile = (p: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
    return pnls[idx] as number;
  };

  let maxPayout: number;
  let minPayout: number;
  let maxIsP99 = false;
  if (bounds.bounded) {
    const ext1 = quantity * (bounds.max as number);
    const ext2 = quantity * (bounds.min as number);
    maxPayout = Math.max(ext1, ext2);
    minPayout = Math.min(ext1, ext2);
  } else {
    // p99 / p1 payout (= PnL percentile + costBasis)
    maxPayout = pctile(0.99) + costBasis;
    minPayout = pctile(0.01) + costBasis;
    maxIsP99 = true;
  }

  // CVaR95 = mean of worst 5% PnLs.
  const tail = Math.max(1, Math.floor(0.05 * n));
  let tailSum = 0;
  for (let i = 0; i < tail; i++) tailSum += pnls[i] as number;
  const cvar95 = tailSum / tail;

  return {
    fairPrice: fair,
    expectedPayout,
    expectedPnl: expectedPayout - costBasis,
    payoutStd,
    maxPayout,
    minPayout,
    maxIsP99,
    pProfit: profitCount / n,
    var95: pctile(0.05),
    cvar95,
    breakevenTheta: breakeven(spec, quantity, costBasis),
  };
}
