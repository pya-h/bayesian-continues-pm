// Drizzle schema — all v1 tables.
// Money columns use a custom numeric(20,8) ⇄ JS number type so balances keep
// precision in the DB but read/write as plain numbers in TS. θ / belief params
// use double precision. Status/type/role columns are varchar tagged with the
// shared string-union types (no pg enums → painless migrations).

import type {
  BeliefStateDTO,
  ContractType,
  DisputeStatus,
  LpLedgerKind,
  MarketCfgState,
  MarketStatus,
  ModelTag,
  OracleMode,
  TransactionKind,
  UserRole,
} from '@bmm/shared';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const money = customType<{ data: number; driverData: string }>({
  dataType() {
    return 'numeric(20, 8)';
  },
  fromDriver(value) {
    return Number(value);
  },
  toDriver(value) {
    return value.toString();
  },
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// users -------------------------------------------------------------------

export const users = pgTable('users', {
  userId: uuid('user_id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 16 }).$type<UserRole>().notNull().default('user'),
  balance: money('balance').notNull().default(0),
  isInfinite: boolean('is_infinite').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// markets -----------------------------------------------------------------

export const markets = pgTable('markets', {
  marketId: uuid('market_id').defaultRandom().primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  outcomeUnit: varchar('outcome_unit', { length: 20 }).notNull(),
  outcomeMin: doublePrecision('outcome_min'),
  outcomeMax: doublePrecision('outcome_max'),
  status: varchar('status', { length: 16 }).$type<MarketStatus>().notNull().default('CREATED'),
  creatorId: uuid('creator_id')
    .notNull()
    .references(() => users.userId),
  beliefKind: varchar('belief_kind', { length: 16 }).notNull().default('gaussian'),
  // Creator-chosen model tag (multi-model refactor). Distinct from belief_kind (the
  // math representation): e.g. a 'gen_basis' market stores belief_kind='mixture'.
  // Set on every market at creation (resolveModel). See ModelTag / D1.
  model: text('model').$type<ModelTag>().notNull().default('gaussian'),
  initialMu: doublePrecision('initial_mu').notNull(),
  initialSigma: doublePrecision('initial_sigma').notNull(),
  currentMu: doublePrecision('current_mu').notNull(),
  currentSigma: doublePrecision('current_sigma').notNull(),
  // Full serialized belief for non-Gaussian markets (mixture / student_t). NULL ⇒
  // Gaussian, reconstructed from current_mu/current_sigma (v1 rows untouched).
  // current_mu/current_sigma are kept in sync as the summary mean/σ for cheap reads.
  beliefState: jsonb('belief_state').$type<BeliefStateDTO>(),
  cfg: jsonb('cfg').$type<Record<string, number | boolean>>().notNull(),
  // Adaptive-parameter controller state: rolling EWMA state + admin control
  // (enable/pin/overrides). NULL ⇒ fresh controller with defaults (no migration of
  // existing rows needed). The static `cfg` above stays the baseline; the live
  // engine config is `adaptParams(cfg, σ₀, cfgState.adaptive)` with pins applied.
  cfgState: jsonb('cfg_state').$type<MarketCfgState>(),
  cash: money('cash').notNull().default(0),
  reserveRequired: money('reserve_required').notNull().default(0),
  lpSharesTotal: money('lp_shares_total').notNull().default(0),
  thetaStar: doublePrecision('theta_star'),
  // oracle assignment. `oracle_mode` picks WHO/WHAT resolves the market after
  // `resolves_at`: `centralized` (the `oracle_user_id` account, or admin if null)
  // `api` (scheduler fetches `oracle_token`'s price from xprices), or `decentralized`
  // (placeholder). `resolved_at` stamps when θ* was set (opens the dispute window).
  oracleMode: varchar('oracle_mode', { length: 16 })
    .$type<OracleMode>()
    .notNull()
    .default('centralized'),
  oracleUserId: uuid('oracle_user_id').references(() => users.userId),
  oracleToken: varchar('oracle_token', { length: 32 }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  // Post-RESOLVED dispute window (seconds). Auto-settle fires once it elapses with
  // no open dispute; 0 ⇒ claims open immediately on resolve.
  disputeWindowSec: integer('dispute_window_sec').notNull().default(86400),
  opensAt: timestamp('opens_at', { withTimezone: true }),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  resolvesAt: timestamp('resolves_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// contracts ---------------------------------------------------------------

export const contracts = pgTable(
  'contracts',
  {
    contractId: uuid('contract_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    contractKey: varchar('contract_key', { length: 128 }).notNull(),
    type: varchar('type', { length: 16 }).$type<ContractType>().notNull(),
    params: jsonb('params').$type<Record<string, number>>().notNull(),
    mmShort: money('mm_short').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => ({
    uqMarketKey: unique('uq_contract_market_key').on(t.marketId, t.contractKey),
    idxMarket: index('idx_contract_market').on(t.marketId),
  }),
);

// positions ---------------------------------------------------------------

export const positions = pgTable(
  'positions',
  {
    positionId: uuid('position_id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.contractId),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    quantity: money('quantity').notNull().default(0),
    avgEntryPrice: money('avg_entry_price').notNull().default(0),
    realizedPnl: money('realized_pnl').notNull().default(0),
    peakUnrealized: money('peak_unrealized').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqUserContract: unique('uq_position_user_contract').on(t.userId, t.contractId),
    idxUser: index('idx_position_user').on(t.userId),
    idxMarket: index('idx_position_market').on(t.marketId),
  }),
);

// trades ------------------------------------------------------------------

export const trades = pgTable(
  'trades',
  {
    tradeId: uuid('trade_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.contractId),
    side: varchar('side', { length: 4 }).$type<'buy' | 'sell'>().notNull(),
    quantity: money('quantity').notNull(),
    execPrice: money('exec_price').notNull(),
    fairPrice: money('fair_price').notNull(),
    spreadTotal: money('spread_total').notNull(),
    totalCost: money('total_cost').notNull(),
    beliefMuBefore: doublePrecision('belief_mu_before').notNull(),
    beliefSigmaBefore: doublePrecision('belief_sigma_before').notNull(),
    beliefMuAfter: doublePrecision('belief_mu_after').notNull(),
    beliefSigmaAfter: doublePrecision('belief_sigma_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    idxMarketTime: index('idx_trade_market_time').on(t.marketId, t.createdAt),
    idxUser: index('idx_trade_user').on(t.userId),
  }),
);

// belief_updates (time-series) --------------------------------------------

export const beliefUpdates = pgTable(
  'belief_updates',
  {
    updateId: uuid('update_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    prevMu: doublePrecision('prev_mu').notNull(),
    prevSigma: doublePrecision('prev_sigma').notNull(),
    newMu: doublePrecision('new_mu').notNull(),
    newSigma: doublePrecision('new_sigma').notNull(),
    signalExtracted: doublePrecision('signal_extracted'),
    signalWeight: doublePrecision('signal_weight'),
    triggerTradeId: uuid('trigger_trade_id'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxMarketTime: index('idx_belief_market_time').on(t.marketId, t.createdAt),
  }),
);

// market_cfg_history ---------------------------
// Time series of the live engine parameters after each fill that moved the
// controller, so an admin can chart how σ_ε / s₀ / α / β adapted over the market's
// life and see when a rail bound. Append-only; reconstructed-from nothing else, so
// it is a real write (unlike the market ledger, which is aggregated).

export const marketCfgHistory = pgTable(
  'market_cfg_history',
  {
    cfgHistoryId: uuid('cfg_history_id').defaultRandom().primaryKey(),
    // Derived observability log with no downstream references → cascade on market
    // delete (keeps test teardown / market cancel simple; nothing depends on it).
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId, { onDelete: 'cascade' }),
    sigmaEps: doublePrecision('sigma_eps').notNull(),
    s0: doublePrecision('s0').notNull(),
    alpha: doublePrecision('alpha').notNull(),
    beta: doublePrecision('beta').notNull(),
    regime: doublePrecision('regime').notNull(),
    railHit: boolean('rail_hit').notNull().default(false),
    // 'adapt' (EWMA-driven), 'pin' (admin override active), or 'breaker' (rail bound).
    source: varchar('source', { length: 16 }).notNull(),
    triggerTradeId: uuid('trigger_trade_id'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxMarketTime: index('idx_cfg_history_market_time').on(t.marketId, t.createdAt),
  }),
);

// lp_positions ------------------------------------------------------------

export const lpPositions = pgTable(
  'lp_positions',
  {
    lpId: uuid('lp_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    shares: money('shares').notNull().default(0),
    totalDeposited: money('total_deposited').notNull().default(0),
    totalWithdrawn: money('total_withdrawn').notNull().default(0),
    claimed: boolean('claimed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqMarketUser: unique('uq_lp_market_user').on(t.marketId, t.userId),
    idxUser: index('idx_lp_user').on(t.userId),
  }),
);

// lp_ledger ---------------------------------------------------------------

export const lpLedger = pgTable(
  'lp_ledger',
  {
    entryId: uuid('entry_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    kind: varchar('kind', { length: 12 }).$type<LpLedgerKind>().notNull(),
    amount: money('amount').notNull(),
    sharesDelta: money('shares_delta').notNull(),
    navBefore: money('nav_before').notNull(),
    sharePrice: money('share_price').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ idxMarketTime: index('idx_lpledger_market_time').on(t.marketId, t.createdAt) }),
);

// oracles (resolution report log) -----------------------------------------

// One row per oracle report that resolved (or re-resolved) a market — the audit
// trail of WHERE each θ* came from. `source` is the originating mode/identity
// ("centralized", "api:xprices", "admin_override"), `token` the xprices symbol for
// `api` reports, `stale` flags a feed read that was rejected as bad data.
export const oracles = pgTable(
  'oracles',
  {
    oracleId: uuid('oracle_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    source: varchar('source', { length: 100 }).notNull(),
    token: varchar('token', { length: 32 }),
    resolvedValue: doublePrecision('resolved_value').notNull(),
    confidence: doublePrecision('confidence'),
    stale: boolean('stale').notNull().default(false),
    disputed: boolean('disputed').notNull().default(false),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ idxMarket: index('idx_oracle_market').on(t.marketId) }),
);

// disputes --------------------------

// A challenge to a market's resolution, filed by a position holder within the
// dispute window. Blocks auto-settle while `open`. An admin closes it: `upheld`
// (θ* overridden to `secondaryValue`, claims re-computed) or `rejected` (the
// resolution stands). Resolution stays gated behind SETTLED, so an open dispute
// holds claims by holding settlement.
export const disputes = pgTable(
  'disputes',
  {
    disputeId: uuid('dispute_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 16 }).$type<DisputeStatus>().notNull().default('open'),
    // The θ* the disputer claims is correct (optional context for the admin).
    proposedValue: doublePrecision('proposed_value'),
    // What the admin set θ* to when upholding (the secondary/override value).
    secondaryValue: doublePrecision('secondary_value'),
    resolverId: uuid('resolver_id').references(() => users.userId),
    resolutionNote: text('resolution_note'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    idxMarket: index('idx_dispute_market').on(t.marketId),
    idxStatus: index('idx_dispute_status').on(t.status),
  }),
);

// claims (trader settlement) ----------------------------------------------

export const claims = pgTable(
  'claims',
  {
    claimId: uuid('claim_id').defaultRandom().primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.marketId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.positionId),
    payout: money('payout').notNull(),
    thetaStar: doublePrecision('theta_star').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqPosition: unique('uq_claim_position').on(t.positionId),
    idxUser: index('idx_claim_user').on(t.userId),
  }),
);

// audit_events (admin actions, top-ups, lifecycle) ------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.userId),
    action: varchar('action', { length: 64 }).notNull(),
    targetId: uuid('target_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => ({
    idxActor: index('idx_audit_actor').on(t.actorId),
    idxCreated: index('idx_audit_created').on(t.createdAt),
  }),
);

// transactions ----------------------------

// Single source of truth for every cash movement, written atomically inside the
// same db transaction as the balance/cash mutation it records. User-centric
// each row belongs to `userId` (whose history it is). `amount` is signed from
// that wallet's perspective (+ inflow, − outflow); `balanceAfter` is the user's
// balance right after the move (null for infinite/admin accounts). `marketId`
// `counterpartyId`, and `refType`/`refId` link the row back to its cause; admin
// funding writes two rows (admin_credit on the target, admin_grant on the admin).
export const transactions = pgTable(
  'transactions',
  {
    txId: uuid('tx_id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    kind: varchar('kind', { length: 24 }).$type<TransactionKind>().notNull(),
    amount: money('amount').notNull(),
    balanceAfter: money('balance_after'),
    marketId: uuid('market_id').references(() => markets.marketId),
    counterpartyId: uuid('counterparty_id').references(() => users.userId),
    refType: varchar('ref_type', { length: 16 }),
    refId: uuid('ref_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => ({
    idxUserTime: index('idx_tx_user_time').on(t.userId, t.createdAt),
    idxMarket: index('idx_tx_market').on(t.marketId),
  }),
);

export const schema = {
  users,
  markets,
  contracts,
  positions,
  trades,
  beliefUpdates,
  lpPositions,
  lpLedger,
  oracles,
  disputes,
  claims,
  auditEvents,
  transactions,
};
