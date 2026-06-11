// API response types — hand-mirrored from the api service return shapes
// (marketView.ts, tradeSvc.ts, lpSvc.ts, statsSvc.ts). Dates arrive over JSON as
// ISO strings, so anything typed `Date` in the service is `string` here.

import type { ContractSpecDTO, MarketStatus, TransactionKind, UserRole } from '@bmm/shared';

export type ContractSpec = ContractSpecDTO;

export interface PublicUser {
  userId: string;
  username: string;
  role: UserRole;
  balance: number;
  isInfinite: boolean;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface BeliefComponent {
  pi: number;
  mu: number;
  sigma: number;
}

export interface Belief {
  kind: 'gaussian' | 'mixture' | 'student_t';
  mu: number;
  sigma: number;
  sigma2: number;
  // Present for mixture markets: per-component weight/mean/σ for the multi-bump chart.
  components?: BeliefComponent[];
}

export interface MarketView {
  marketId: string;
  title: string;
  description: string | null;
  outcomeUnit: string;
  outcomeMin: number | null;
  outcomeMax: number | null;
  status: MarketStatus;
  creatorId: string;
  belief: Belief;
  cfg: Record<string, number | boolean>;
  cash: number;
  reserveRequired: number;
  pool: { nav: number; sharesTotal: number; sharePrice: number };
  thetaStar: number | null;
  opensAt: string | null;
  closesAt: string | null;
  resolvesAt: string | null;
  createdAt: string;
}

export interface SpreadBreakdown {
  base: number;
  inventory: number;
  adverseSelection: number;
  volatility: number;
  total: number;
}

export interface Quote {
  side: 'buy' | 'sell';
  q: number;
  fair: number;
  spread: SpreadBreakdown;
  execPrice: number;
  totalCost: number;
  projectedBelief: { mu: number; sigma: number };
  projectedReserve: number;
  maxExecutable: number;
}

export interface Fill {
  tradeId: string;
  contractId: string;
  side: 'buy' | 'sell';
  requestedQ: number;
  filledQ: number;
  partial: boolean;
  fair: number;
  execPrice: number;
  spreadTotal: number;
  totalCost: number;
  beliefBefore: { mu: number; sigma: number };
  beliefAfter: { mu: number; sigma: number };
  reserveRequired: number;
  cash: number;
  balance: number | null;
  position: { quantity: number; avgEntryPrice: number; realizedPnl: number };
}

export interface SellAllFill {
  tradeId: string;
  contractId: string;
  contractKey: string;
  spec: ContractSpec;
  quantity: number;
  execPrice: number;
  proceeds: number;
  realizedPnl: number;
  partial: boolean;
}

export interface SellAllResult {
  marketId: string;
  count: number;
  fills: SellAllFill[];
  totalProceeds: number;
  totalRealizedPnl: number;
  cash: number;
  reserveRequired: number;
  balance: number | null;
  beliefAfter: { mu: number; sigma: number };
}

export interface MarketStats {
  marketId: string;
  status: MarketStatus;
  belief: Belief;
  impliedPrice: number;
  volume: number;
  trades: number;
  traders: number;
  nav: number;
  beliefDrift: number;
  calibration: { thetaStar: number; ci80: { lo: number; hi: number }; inCi80: boolean } | null;
}

export interface BeliefHistoryPoint {
  t: string;
  mu: number;
  sigma: number;
}

export interface MarketHistory {
  marketId: string;
  beliefHistory: BeliefHistoryPoint[];
  priceHistory: { contractKey: string; points: { t: string; fair: number }[] } | null;
}

export interface PortfolioPosition {
  marketId: string;
  marketTitle: string;
  marketStatus: MarketStatus;
  contractId: string;
  contractKey: string;
  spec: ContractSpec;
  quantity: number;
  avgEntryPrice: number;
  costBasis: number;
  fair: number;
  bid: number;
  positionValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  peakProfit: number;
  drawdownFromPeak: number;
  openedAt: string;
  lastTradedAt: string;
  final: { thetaStar: number; payout: number; finalPnl: number; claimed: boolean } | null;
}

export interface Portfolio {
  userId: string;
  positions: PortfolioPosition[];
  totals: { realized: number; unrealized: number; total: number; marketValue: number };
}

export interface PositionStats {
  fairPrice: number;
  expectedPayout: number;
  expectedPnl: number;
  payoutStd: number;
  maxPayout: number;
  minPayout: number;
  maxIsP99: boolean;
  pProfit: number;
  var95: number;
  cvar95: number;
  breakevenTheta: number | null;
}

export interface PositionDetail {
  marketId: string;
  marketStatus: MarketStatus;
  contractId: string;
  contractKey: string;
  spec: ContractSpec;
  quantity: number;
  avgEntryPrice: number;
  costBasis: number;
  realizedPnl: number;
  stats: PositionStats;
  markPath: { points: number[]; peak: number; maxDrawdown: number; last: number };
  storedPeakUnrealized: number;
  final: { thetaStar: number; payout: number; finalPnl: number } | null;
}

// LP (lpSvc.ts) ---

export interface LpPool {
  cash: number;
  reserveRequired: number;
  nav: number;
  sharesTotal: number;
  sharePrice: number;
}

export interface LpView {
  marketId: string;
  status: MarketStatus;
  pool: LpPool;
  your: {
    shares: number;
    sharePct: number;
    totalDeposited: number;
    totalWithdrawn: number;
    estValue: number;
    claimed: boolean;
  } | null;
}

export interface LpDepositResult {
  minted: number;
  navBefore: number;
  lp: LpView;
}

export interface LpWithdrawResult {
  cashOut: number;
  burned: number;
  partial: boolean;
  lp: LpView;
}

export interface LpClaimResult {
  credited: number;
  pnl: number;
  alreadyClaimed: boolean;
  cashFinal: number;
  lp: LpView;
}

// admin ---

export interface AdminUser {
  userId: string;
  username: string;
  role: UserRole;
  balance: number;
  isInfinite: boolean;
  createdAt: string;
}

export interface AuditEvent {
  eventId: string;
  actorId: string | null;
  actor: string | null;
  action: string;
  targetId: string | null;
  targetType: 'market' | 'user' | null;
  targetLabel: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminMarketOverview {
  marketId: string;
  status: MarketStatus;
  belief: { mu: number; sigma: number; sigma2: number };
  impliedPrice: number;
  volume: number;
  trades: number;
  traders: number;
  spreadIncome: number;
  expectedLiability: number;
  cash: number;
  nav: number;
  reserveRequired: number;
  reserveUtil: number;
  mmPnl: number;
  beliefDrift: number;
  calibration: { thetaStar: number; ci80: { lo: number; hi: number }; inCi80: boolean } | null;
}

export interface MarketCfgInput {
  sigmaMin?: number;
  sigmaEps?: number;
  s0?: number;
  gamma?: number;
  lambda?: number;
  eta?: number;
  alpha?: number;
  beta?: number;
  qMax?: number;
  qThreshold?: number;
  lr?: number;
  decay?: number;
  reserveAlpha?: number;
  useSimplifiedUpdate?: boolean;
}

export type CreateBeliefInput =
  | { kind: 'gaussian' }
  | { kind: 'mixture'; components: { pi: number; mu: number; sigma: number }[] }
  | { kind: 'student_t'; nu: number };

export interface CreateMarketInput {
  title: string;
  description?: string;
  outcomeUnit: string;
  outcomeMin?: number;
  outcomeMax?: number;
  initialMu: number;
  initialSigma: number;
  initialReserve: number;
  belief?: CreateBeliefInput;
  cfg?: MarketCfgInput;
}

// One row of the transaction ledger. `amount` is
// signed from the wallet's view (+ inflow, − outflow); `balanceAfter` is null for
// infinite/admin accounts. Dates are ISO strings.
export interface Transaction {
  txId: string;
  kind: TransactionKind;
  amount: number;
  balanceAfter: number | null;
  marketId: string | null;
  marketTitle: string | null;
  counterpartyId: string | null;
  counterparty: string | null;
  refType: string | null;
  refId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface TransactionSummary {
  count: number;
  funded: number;
  claimed: number;
  tradeBuy: number;
  tradeSell: number;
  lpDeposited: number;
  lpWithdrawn: number;
  refunded: number;
  net: number;
}

export interface UserTransactions {
  transactions: Transaction[];
  summary: TransactionSummary;
}

// admin market ledger (marketLedgerSvc.ts) ---

export type MarketLedgerKind =
  | 'genesis'
  | 'lp_deposit'
  | 'lp_withdraw'
  | 'lp_claim'
  | 'trade_buy'
  | 'trade_sell'
  | 'refund'
  | 'trader_payout';

export interface MarketLedgerEvent {
  at: string;
  kind: MarketLedgerKind;
  delta: number;
  affectsCash: boolean;
  cashAfter: number | null;
  userId: string | null;
  username: string | null;
  ref: { type: string; id: string } | null;
  note?: string;
}

export interface MarketLedgerRollup {
  genesisReserve: number;
  lpDeposits: number;
  lpWithdrawals: number;
  premiumIn: number;
  premiumOut: number;
  refunds: number;
  traderPayouts: number;
  lpClaimsPaid: number;
  netPoolChange: number;
  currentCash: number;
  reserveRequired: number;
  nav: number;
  cashFinal: number;
  reconciles: boolean;
  tradeCount: number;
  lpEventCount: number;
  eventCount: number;
}

export interface MarketLedger {
  marketId: string;
  title: string;
  status: MarketStatus;
  createdAt: string;
  events: MarketLedgerEvent[];
  rollup: MarketLedgerRollup;
}

export interface SystemAlert {
  type: 'system:alert';
  marketId: string;
  kind: 'belief_divergence' | 'rapid_price_move' | 'insolvency_risk';
  severity: 'info' | 'warning' | 'critical';
  action: 'alert' | 'suspend' | 'reject';
  message: string;
  value: number;
  threshold: number;
  at: string;
}
