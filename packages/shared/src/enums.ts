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
} as const;
export type BeliefKind = (typeof BeliefKind)[keyof typeof BeliefKind];

// Market-level model tag (multi-model refactor). This is the creator's *chosen*
// model — it drives the create UI and the belief-update config — and is distinct
// from `BeliefKind`, which is the math/serialization representation. Notably
// `gen_basis` is stored as `belief_kind = 'mixture'` (an adaptive mixture); the
// `model` tag is what carries its distinct identity. Legacy rows (model = null)
// infer `model = belief_kind`. See model/).
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
