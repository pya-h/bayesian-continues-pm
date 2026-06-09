// TanStack Query hooks over the api client. Query keys are stable + namespaced.

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';

export const qk = {
  markets: ['markets'] as const,
  market: (id: string) => ['market', id] as const,
  stats: (id: string) => ['stats', id] as const,
  history: (id: string, key?: string) => ['history', id, key ?? null] as const,
  portfolio: ['portfolio'] as const,
  transactions: ['transactions'] as const,
  position: (contractId: string) => ['position', contractId] as const,
  lp: (id: string) => ['lp', id] as const,
  adminUsers: ['admin', 'users'] as const,
  adminOverview: (id: string) => ['admin', 'overview', id] as const,
};

export function useMarkets() {
  return useQuery({
    queryKey: qk.markets,
    queryFn: () => api.markets().then((r) => r.markets),
  });
}

export function useMarket(id: string) {
  return useQuery({
    queryKey: qk.market(id),
    queryFn: () => api.market(id).then((r) => r.market),
  });
}

export function useMarketStats(id: string) {
  return useQuery({
    queryKey: qk.stats(id),
    queryFn: () => api.stats(id).then((r) => r.stats),
  });
}

export function useMarketHistory(id: string, contractKey?: string) {
  return useQuery({
    queryKey: qk.history(id, contractKey),
    queryFn: () => api.history(id, contractKey).then((r) => r.history),
  });
}

export function usePortfolio() {
  return useQuery({
    queryKey: qk.portfolio,
    queryFn: () => api.portfolio().then((r) => r.portfolio),
  });
}

export function useTransactions() {
  return useQuery({
    queryKey: qk.transactions,
    queryFn: () => api.transactions(),
  });
}

export function useLpView(id: string) {
  return useQuery({
    queryKey: qk.lp(id),
    queryFn: () => api.lp(id).then((r) => r.lp),
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: qk.adminUsers,
    queryFn: () => api.adminUsers().then((r) => r.users),
    enabled,
  });
}

export function useAdminOverview(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.adminOverview(id),
    queryFn: () => api.adminOverview(id).then((r) => r.overview),
    enabled,
  });
}
