// Tiny typed fetch client. Attaches the bearer token, parses JSON, and turns any
// non-2xx into a thrown `ApiError` carrying the server's `{ error }` message so
// TanStack Query surfaces it uniformly.

import type {
  AdminMarketOverview,
  AdminUser,
  AuthResponse,
  CreateMarketInput,
  Fill,
  LpClaimResult,
  LpDepositResult,
  LpView,
  LpWithdrawResult,
  MarketHistory,
  MarketLedger,
  MarketStats,
  MarketView,
  Portfolio,
  PositionDetail,
  PublicUser,
  Quote,
  SellAllResult,
  UserTransactions,
} from './types.ts';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
export const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000/ws';

const TOKEN_KEY = 'bmm.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `Network error — is the API running at ${API_URL}? (${String(e)})`);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.error || data.detail)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

import type { ContractSpec } from './types.ts';

export const api = {
  // auth ---
  register: (username: string, password: string) =>
    request<AuthResponse>('/auth/register', { body: { username, password }, auth: false }),
  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', { body: { username, password }, auth: false }),
  me: () => request<{ user: AuthResponse['user'] }>('/auth/me'),

  // markets (public) ---
  markets: () => request<{ markets: MarketView[] }>('/markets', { auth: false }),
  market: (id: string) => request<{ market: MarketView }>(`/markets/${id}`, { auth: false }),
  stats: (id: string) => request<{ stats: MarketStats }>(`/markets/${id}/stats`, { auth: false }),
  history: (id: string, contractKey?: string) =>
    request<{ history: MarketHistory }>(
      `/markets/${id}/history${contractKey ? `?contractKey=${encodeURIComponent(contractKey)}` : ''}`,
      { auth: false },
    ),

  // trading ---
  quote: (id: string, spec: ContractSpec, q: number) =>
    request<{ quote: Quote }>(`/markets/${id}/quote`, { body: { spec, q } }),
  trade: (id: string, spec: ContractSpec, q: number, maxPrice?: number) =>
    request<{ fill: Fill }>(`/markets/${id}/trade`, { body: { spec, q, maxPrice } }),
  sellAll: (id: string) =>
    request<{ result: SellAllResult }>(`/markets/${id}/sell-all`, { method: 'POST' }),
  claim: (id: string) =>
    request<{ claim: { credited: number; payout: number; alreadyClaimed: boolean } }>(
      `/markets/${id}/claim`,
      { method: 'POST' },
    ),

  // portfolio ---
  portfolio: () => request<{ portfolio: Portfolio }>('/users/me/portfolio'),
  positionDetail: (contractId: string) =>
    request<{ position: PositionDetail }>(`/users/me/positions/${contractId}`),
  transactions: () => request<UserTransactions>('/users/me/transactions'),

  // liquidity provision ---
  lp: (id: string) => request<{ lp: LpView }>(`/markets/${id}/lp`),
  lpDeposit: (id: string, amount: number) =>
    request<{ deposit: LpDepositResult }>(`/markets/${id}/lp/deposit`, { body: { amount } }),
  lpWithdraw: (id: string, shares: number) =>
    request<{ withdraw: LpWithdrawResult }>(`/markets/${id}/lp/withdraw`, { body: { shares } }),
  lpClaim: (id: string) =>
    request<{ claim: LpClaimResult }>(`/markets/${id}/lp/claim`, { method: 'POST' }),

  // admin ---
  adminCreateMarket: (input: CreateMarketInput) =>
    request<{ market: MarketView }>('/admin/markets', { body: input }),
  adminLifecycle: (id: string, action: string, body?: unknown) =>
    request<{ market: MarketView }>(`/admin/markets/${id}/${action}`, {
      method: 'POST',
      body,
    }),
  adminOverview: (id: string) =>
    request<{ overview: AdminMarketOverview }>(`/admin/markets/${id}/overview`),
  adminMarketLedger: (id: string) =>
    request<{ ledger: MarketLedger }>(`/admin/markets/${id}/ledger`),
  adminUsers: () => request<{ users: AdminUser[] }>('/admin/users'),
  adminTopup: (userId: string, amount: number) =>
    request<{ user: PublicUser }>(`/admin/users/${userId}/topup`, { body: { amount } }),
  adminUserTransactions: (userId: string) =>
    request<UserTransactions>(`/admin/users/${userId}/transactions`),
};
