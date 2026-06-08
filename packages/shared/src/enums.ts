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

// User tiers — v1 informational only (no leverage yet).
export const UserTier = {
  NEW: 'new',
  VERIFIED: 'verified',
  ADVANCED: 'advanced',
  INSTITUTIONAL: 'institutional',
} as const;
export type UserTier = (typeof UserTier)[keyof typeof UserTier];
