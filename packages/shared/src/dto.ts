// Zod DTO schemas shared by the API (request/response validation) and the web
// client. Foundational set for; extended per feature phase.

import { z } from 'zod';

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
  ])
  .superRefine((val, ctx) => {
    if (val.type === 'SPREAD' && !(val.lower < val.upper)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SPREAD requires lower < upper' });
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
export const beliefStateSchema = z.discriminatedUnion('kind', [
  gaussianStateSchema,
  mixtureStateSchema,
  studentTStateSchema,
]);
export type BeliefStateDTO = z.infer<typeof beliefStateSchema>;

// Belief config at market creation (input) --------------------------------

export const createMixtureComponentSchema = z.object({
  pi: positive,
  mu: outcome,
  sigma: spread,
});
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
});
export type CreateMarketDTO = z.infer<typeof createMarketSchema>;

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

// LP ----------------------------------------------------------------------

export const lpDepositSchema = z.object({ amount: positive });
export const lpWithdrawSchema = z.object({ shares: positive });
export type LpDepositDTO = z.infer<typeof lpDepositSchema>;
export type LpWithdrawDTO = z.infer<typeof lpWithdrawSchema>;
