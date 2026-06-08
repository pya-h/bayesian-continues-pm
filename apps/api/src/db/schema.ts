// Drizzle schema — all v1 tables.
// Money columns use a custom numeric(20,8) ⇄ JS number type so balances keep
// precision in the DB but read/write as plain numbers in TS. θ / belief params
// use double precision. Status/type/role columns are varchar tagged with the
// shared string-union types (no pg enums → painless migrations).

import type { ContractType, LpLedgerKind, MarketStatus, UserRole, UserTier } from '@bmm/shared';
import {
  boolean,
  customType,
  doublePrecision,
  index,
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
  tier: varchar('tier', { length: 16 }).$type<UserTier>().notNull().default('new'),
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
  initialMu: doublePrecision('initial_mu').notNull(),
  initialSigma: doublePrecision('initial_sigma').notNull(),
  currentMu: doublePrecision('current_mu').notNull(),
  currentSigma: doublePrecision('current_sigma').notNull(),
  cfg: jsonb('cfg').$type<Record<string, number | boolean>>().notNull(),
  cash: money('cash').notNull().default(0),
  reserveRequired: money('reserve_required').notNull().default(0),
  lpSharesTotal: money('lp_shares_total').notNull().default(0),
  thetaStar: doublePrecision('theta_star'),
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

// oracles -----------------------------------------------------------------

export const oracles = pgTable('oracles', {
  oracleId: uuid('oracle_id').defaultRandom().primaryKey(),
  marketId: uuid('market_id')
    .notNull()
    .references(() => markets.marketId),
  source: varchar('source', { length: 100 }).notNull(),
  resolvedValue: doublePrecision('resolved_value').notNull(),
  confidence: doublePrecision('confidence'),
  disputed: boolean('disputed').notNull().default(false),
  reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  claims,
  auditEvents,
};
