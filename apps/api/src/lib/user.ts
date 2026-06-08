import type { UserRow } from '../db/repos.ts';

export function publicUser(u: UserRow) {
  return {
    userId: u.userId,
    username: u.username,
    role: u.role,
    balance: u.balance,
    isInfinite: u.isInfinite,
    tier: u.tier,
    createdAt: u.createdAt,
  };
}
export type PublicUser = ReturnType<typeof publicUser>;
