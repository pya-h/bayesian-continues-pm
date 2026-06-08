// @bmm/shared — types, enums, DTO schemas, and money helpers shared by api + web.
// skeleton with the enums that the rest of the system pins against.
// Fleshed out in (zod DTOs, full money utils).

export const SHARED_VERSION = '0.1.0';

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
