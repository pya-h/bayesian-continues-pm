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
  // v2: MIXTURE: 'mixture', STUDENT_T: 'student_t'
} as const;
export type BeliefKind = (typeof BeliefKind)[keyof typeof BeliefKind];

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

// User tiers — v1 informational only (no leverage yet).
export const UserTier = {
  NEW: 'new',
  VERIFIED: 'verified',
  ADVANCED: 'advanced',
  INSTITUTIONAL: 'institutional',
} as const;
export type UserTier = (typeof UserTier)[keyof typeof UserTier];
