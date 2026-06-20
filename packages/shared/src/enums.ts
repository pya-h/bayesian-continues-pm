export const MarketStatus = {
  CREATED: 'CREATED',
  OPEN: 'OPEN',
  SUSPENDED: 'SUSPENDED',
  RESOLVED: 'RESOLVED',
  SETTLED: 'SETTLED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;
export type MarketStatus = (typeof MarketStatus)[keyof typeof MarketStatus];

export const ContractType = {
  LINEAR: 'LINEAR',
  CALL: 'CALL',
  PUT: 'PUT',
  BINARY_CALL: 'BINARY_CALL',
  BINARY_PUT: 'BINARY_PUT',
  SPREAD: 'SPREAD',
  GAUSSIAN: 'GAUSSIAN',
  // bounded shape-extensions (all payoffs ∈ [0,1], zero risk-model change).
  SKEW_GAUSSIAN: 'SKEW_GAUSSIAN',
  TENT: 'TENT',
  TRAPEZOID: 'TRAPEZOID',
  SIGMOID: 'SIGMOID',
  // conditionally-compatible (unbounded; bounded-outcome markets only, and
  // never EXPONENTIAL / high-degree POLYNOMIAL on a heavy-tailed Student-t belief).
  POLYNOMIAL: 'POLYNOMIAL',
  EXPONENTIAL: 'EXPONENTIAL',
} as const;
export type ContractType = (typeof ContractType)[keyof typeof ContractType];

export const UserRole = {
  USER: 'user',
  ADMIN: 'admin',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const BeliefKind = {
  GAUSSIAN: 'gaussian',
  MIXTURE: 'mixture',
  STUDENT_T: 'student_t',
  GEN_EXACT: 'gen_exact',
} as const;
export type BeliefKind = (typeof BeliefKind)[keyof typeof BeliefKind];

// Market-level model tag (multi-model refactor). This is the creator's *chosen*
// model — it drives the create UI and the belief-update config — and is distinct
// from `BeliefKind`, which is the math/serialization representation. Notably
// `gen_basis` is stored as `belief_kind = 'mixture'` (an adaptive mixture); the
// `model` tag is what carries its distinct identity. Set on every market at
// creation. See model/).
export const ModelTag = {
  GAUSSIAN: 'gaussian',
  STUDENT_T: 'student_t',
  MIXTURE: 'mixture',
  GEN_BASIS: 'gen_basis',
  GEN_EXACT: 'gen_exact',
} as const;
export type ModelTag = (typeof ModelTag)[keyof typeof ModelTag];

export const LpLedgerKind = {
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
  CLAIM: 'claim',
} as const;
export type LpLedgerKind = (typeof LpLedgerKind)[keyof typeof LpLedgerKind];

// Transaction-ledger kinds — one per kind of cash movement recorded in the
// `transactions` table. `amount` is always signed from the row owner's wallet
// perspective (+ into the wallet, − out). Admin funding records two rows
// `admin_credit` on the funded user and `admin_grant` on the admin who paid.
export const TransactionKind = {
  TRADE_BUY: 'trade_buy',
  TRADE_SELL: 'trade_sell',
  MARKET_CREATE: 'market_create',
  LP_DEPOSIT: 'lp_deposit',
  LP_WITHDRAW: 'lp_withdraw',
  LP_CLAIM: 'lp_claim',
  CLAIM: 'claim',
  REFUND: 'refund',
  ADMIN_CREDIT: 'admin_credit',
  ADMIN_GRANT: 'admin_grant',
} as const;
export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];
