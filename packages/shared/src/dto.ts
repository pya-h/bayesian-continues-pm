// Zod DTO schemas shared by the API (request/response validation) and the web
// client. Foundational set for; extended per feature phase.

import { z } from 'zod';
import { type DisputeStatus, OracleMode, UserRole } from './enums.ts';

const finite = z.number().finite();
const positive = z.number().finite().positive();

// Outcome-axis magnitude ceiling. Strikes / centers / bounds / μ and their spreads
// are bounded well below the float-overflow regime (~1e155, where (θ−μ)² overflows
// and silently corrupts a Gaussian belief or NaN-prices a Student-t —
// C46). 1e12 (a trillion) covers any realistic outcome value while keeping (θ−μ)²
// ≤ ~4e24, far from overflow.
const OUTCOME_BOUND = 1e12;
const outcome = z.number().finite().min(-OUTCOME_BOUND).max(OUTCOME_BOUND);
const spread = z.number().finite().positive().max(OUTCOME_BOUND);

// Max degree of a POLYNOMIAL contract.
// Kept as a local literal so `shared` stays free of a `core` dependency.
const MAX_POLYNOMIAL_DEGREE = 4;
const coeff = z.number().finite().min(-OUTCOME_BOUND).max(OUTCOME_BOUND);
const variance = z
  .number()
  .finite()
  .positive()
  .max(OUTCOME_BOUND * OUTCOME_BOUND);

// Contracts ---------------------------------------------------------------

export const contractSpecSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('LINEAR') }),
    z.object({ type: z.literal('CALL'), strike: outcome }),
    z.object({ type: z.literal('PUT'), strike: outcome }),
    z.object({ type: z.literal('BINARY_CALL'), strike: outcome }),
    z.object({ type: z.literal('BINARY_PUT'), strike: outcome }),
    z.object({ type: z.literal('SPREAD'), lower: outcome, upper: outcome }),
    z.object({ type: z.literal('GAUSSIAN'), center: outcome, width: spread }),
    // bounded shape-extensions.
    z.object({
      type: z.literal('SKEW_GAUSSIAN'),
      center: outcome,
      widthLeft: spread,
      widthRight: spread,
    }),
    z.object({ type: z.literal('TENT'), center: outcome, width: spread }),
    z.object({ type: z.literal('TRAPEZOID'), lower: outcome, upper: outcome, width: spread }),
    z.object({ type: z.literal('SIGMOID'), center: outcome, width: spread }),
    // conditionally-compatible (unbounded). The market-belief integrability +
    // bounded-outcome guard is enforced server-side at quote/trade, not here.
    z.object({
      type: z.literal('POLYNOMIAL'),
      coeffs: z
        .array(coeff)
        .min(1)
        .max(MAX_POLYNOMIAL_DEGREE + 1),
    }),
    z.object({ type: z.literal('EXPONENTIAL'), center: outcome, rate: finite }),
  ])
  .superRefine((val, ctx) => {
    if (val.type === 'SPREAD' && !(val.lower < val.upper)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SPREAD requires lower < upper' });
    }
    if (val.type === 'TRAPEZOID' && !(val.lower < val.upper)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TRAPEZOID requires lower < upper' });
    }
    if (val.type === 'POLYNOMIAL' && !val.coeffs.some((a, k) => k >= 1 && a !== 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'POLYNOMIAL must be non-constant' });
    }
    if (val.type === 'EXPONENTIAL' && val.rate === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'EXPONENTIAL requires a non-zero rate',
      });
    }
  });
export type ContractSpecDTO = z.infer<typeof contractSpecSchema>;

// Belief ------------------------------------------------------------------

export const gaussianStateSchema = z.object({
  kind: z.literal('gaussian'),
  mu: outcome,
  sigma2: variance,
});
// A persisted mixture component: weight π, mean μ, variance σ².
export const mixtureComponentStateSchema = z.object({
  pi: z.number().finite().nonnegative(),
  mu: outcome,
  sigma2: variance,
});
export const mixtureStateSchema = z.object({
  kind: z.literal('mixture'),
  components: z.array(mixtureComponentStateSchema).min(1),
});
export const studentTStateSchema = z.object({
  kind: z.literal('student_t'),
  nu: z.number().finite().gt(2),
  mu: outcome,
  scale2: variance,
});
// The three exponent shape coefficients of a Gen·exact belief: [λ₂, λ₃, λ₄] of
// `E(u) = ½λ₂u² + λ₃u³ + λ₄u⁴ (+ stabiliser λ₆u⁶)`, `u = (θ−μ)/σ`. Bounds are the
// **sandbox-safe ranges**: λ₂∈[−4,4]
// (negative ⇒ bimodal), λ₃∈[−0.35,0.35] (skew, = slider α/40 over ±14)
// λ₄∈[0,1.6] (flat-top / thinner tails). The u⁶ auto-stabiliser keeps any value in
// range integrable. See model/).
export const genExactLambdasSchema = z.tuple([
  finite.min(-4).max(4),
  finite.min(-0.35).max(0.35),
  finite.min(0).max(1.6),
]);
// Cached standardised moments {emin, z, E[u], E[u²]} of a Gen·exact shape
// a λ-only function persisted so reads skip the normalisation
// quadrature. Optional: a snapshot without it is recomputed on load.
export const genExactMomentsSchema = z.object({
  emin: finite,
  z: finite.positive(),
  eu: finite,
  eu2: finite,
});
// Serialized snapshot of a max-entropy exp(−poly) belief (Gen·exact, kind G2).
export const genExactStateSchema = z.object({
  kind: z.literal('gen_exact'),
  mu: outcome,
  sigma: spread,
  lambdas: genExactLambdasSchema,
  moments: genExactMomentsSchema.optional(),
});
export const beliefStateSchema = z.discriminatedUnion('kind', [
  gaussianStateSchema,
  mixtureStateSchema,
  studentTStateSchema,
  genExactStateSchema,
]);
export type BeliefStateDTO = z.infer<typeof beliefStateSchema>;

// Belief config at market creation (input) --------------------------------

export const createMixtureComponentSchema = z.object({
  pi: positive,
  mu: outcome,
  sigma: spread,
});
// One Gen·basis bump as authored at creation: center + spread (stddev) + weight.
// Whatever editor the UI offers (grid / modes-and-spread) just *generates* this
// list; the belief itself is an adaptive Gaussian mixture.
export const createGenBasisBumpSchema = z.object({
  mu: outcome,
  sigma: spread,
  weight: positive,
});
export const MAX_GEN_BASIS_BUMPS = 12;
export const createBeliefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gaussian') }),
  z.object({
    kind: z.literal('mixture'),
    components: z.array(createMixtureComponentSchema).min(2).max(6),
  }),
  // Student-t reuses the market's initialMu/initialSigma as its location/spread
  // only the degrees of freedom ν (>2, for finite variance) are authored here.
  z.object({
    kind: z.literal('student_t'),
    nu: z.number().finite().gt(2),
  }),
  // multi-model refactor --------
  // Gen·basis: an adaptive Gaussian mixture authored as a list of bumps.
  z.object({
    kind: z.literal('gen_basis'),
    bumps: z.array(createGenBasisBumpSchema).min(1).max(MAX_GEN_BASIS_BUMPS),
  }),
  // Gen·exact: max-entropy exp(−poly); reuses initialMu/initialSigma as μ/σ (like
  // student_t), authoring only the exponent shape coefficients λ.
  z.object({
    kind: z.literal('gen_exact'),
    lambdas: genExactLambdasSchema,
  }),
]);
export type CreateBeliefDTO = z.infer<typeof createBeliefSchema>;

// Engine config overrides ------------------------------------

export const marketCfgSchema = z
  .object({
    sigmaMin: positive,
    sigmaEps: positive,
    s0: z.number().finite().nonnegative(),
    gamma: z.number().finite().nonnegative(),
    lambda: z.number().finite().nonnegative(),
    eta: z.number().finite().nonnegative(),
    alpha: positive,
    beta: positive,
    qMax: positive,
    qThreshold: positive,
    lr: z.number().finite().nonnegative(),
    decay: z.number().finite().nonnegative(),
    reserveAlpha: z.number().gt(0).lt(1),
    useSimplifiedUpdate: z.boolean(),
  })
  .partial();
export type MarketCfgDTO = z.infer<typeof marketCfgSchema>;

// Auth --------------------------------------------------------------------

export const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'letters, digits, _ . - only'),
  password: z.string().min(6).max(128),
});
export type RegisterDTO = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginDTO = z.infer<typeof loginSchema>;

// Admin -------------------------------------------------------------------

export const topupSchema = z.object({ amount: positive });
export type TopupDTO = z.infer<typeof topupSchema>;

export const createMarketSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(4000).optional(),
  outcomeUnit: z.string().min(1).max(20),
  outcomeMin: outcome.optional(),
  outcomeMax: outcome.optional(),
  initialMu: outcome,
  initialSigma: spread,
  initialReserve: positive,
  belief: createBeliefSchema.optional(),
  cfg: marketCfgSchema.optional(),
  opensAt: z.string().datetime().optional(),
  closesAt: z.string().datetime().optional(),
  resolvesAt: z.string().datetime().optional(),
  // oracle assignment. Defaults to `centralized` resolved by the admin (null
  // oracleUserId) — the V1 manual-resolve behaviour.
  oracleMode: z.nativeEnum(OracleMode).optional(),
  // `centralized`: the role=oracle (or admin) account that may resolve. null ⇒ admin-only.
  oracleUserId: z.string().uuid().optional(),
  // `api`: the xprices token symbol whose price becomes θ* at the deadline (e.g. "BTC").
  oracleToken: z.string().min(1).max(32).optional(),
  // Post-RESOLVED dispute window in seconds (0 ⇒ claims open immediately).
  disputeWindowSec: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 3600)
    .optional(),
});
export const createMarketSchemaChecked = createMarketSchema.superRefine((val, ctx) => {
  if (
    val.outcomeMin !== undefined &&
    val.outcomeMax !== undefined &&
    !(val.outcomeMin < val.outcomeMax)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'outcomeMin must be less than outcomeMax',
      path: ['outcomeMax'],
    });
  }
  // `api` oracle mode is only meaningful for a crypto-price market: it needs a token
  // symbol to query. Without one there is nothing for the scheduler to resolve from.
  if (val.oracleMode === OracleMode.API && !val.oracleToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'oracleToken is required when oracleMode is "api"',
      path: ['oracleToken'],
    });
  }
});
export type CreateMarketDTO = z.infer<typeof createMarketSchema>;

// Oracles & disputes -----------------------------------------------

// Body for a centralized-oracle (or admin) resolution: the reported outcome θ*.
export const oracleResolveSchema = z.object({ thetaStar: outcome });
export type OracleResolveDTO = z.infer<typeof oracleResolveSchema>;

export const setRoleSchema = z.object({ role: z.nativeEnum(UserRole) });
export type SetRoleDTO = z.infer<typeof setRoleSchema>;

export const disputeSchema = z.object({
  reason: z.string().min(1).max(1000),
  // Optional: the θ* the disputer believes is correct (context for the admin).
  proposedValue: outcome.optional(),
});
export type DisputeDTO = z.infer<typeof disputeSchema>;

// Admin closing a dispute: uphold (override θ* to secondaryValue) or reject.
export const resolveDisputeSchema = z
  .object({
    action: z.enum(['uphold', 'reject']),
    secondaryValue: outcome.optional(),
    note: z.string().max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.action === 'uphold' && val.secondaryValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'secondaryValue (the corrected θ*) is required when upholding a dispute',
        path: ['secondaryValue'],
      });
    }
  });
export type ResolveDisputeDTO = z.infer<typeof resolveDisputeSchema>;

export interface DisputeView {
  disputeId: string;
  marketId: string;
  marketTitle?: string;
  userId: string;
  username?: string;
  reason: string;
  status: DisputeStatus;
  proposedValue: number | null;
  secondaryValue: number | null;
  resolverId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// Trading -----------------------------------------------------------------

export const quoteSchema = z.object({
  spec: contractSpecSchema,
  q: finite.refine((v) => v !== 0, 'q must be non-zero'),
});
export type QuoteDTO = z.infer<typeof quoteSchema>;

export const tradeSchema = z.object({
  spec: contractSpecSchema,
  q: finite.refine((v) => v !== 0, 'q must be non-zero'),
  maxPrice: finite.optional(), // slippage bound (per unit)
});
export type TradeDTO = z.infer<typeof tradeSchema>;

// Adaptive parameters ----------------------------------------------

export interface AdaptiveStateDTO {
  emaSlow: number;
  emaFast: number;
  count: number;
}

export interface AdaptiveControlDTO {
  enabled?: boolean;
  pinned?: { sigmaEps?: number; s0?: number; alpha?: number; beta?: number };
  cfg?: Record<string, number | boolean>;
}

export interface MarketCfgState {
  adaptive: AdaptiveStateDTO;
  control?: AdaptiveControlDTO;
}

export const adaptiveControlSchema = z
  .object({
    enabled: z.boolean().optional(),
    pinned: z
      .object({
        sigmaEps: positive.optional(),
        s0: positive.optional(),
        alpha: positive.optional(),
        beta: positive.optional(),
      })
      .strict()
      .optional(),
    cfg: z.record(z.union([z.number().finite(), z.boolean()])).optional(),
  })
  .strict();
export type AdaptiveControlInput = z.infer<typeof adaptiveControlSchema>;

// LP ----------------------------------------------------------------------

export const lpDepositSchema = z.object({ amount: positive });
export const lpWithdrawSchema = z.object({ shares: positive });
export type LpDepositDTO = z.infer<typeof lpDepositSchema>;
export type LpWithdrawDTO = z.infer<typeof lpWithdrawSchema>;
