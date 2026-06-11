CREATE TABLE "belief_updates" (
	"update_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"prev_mu" double precision NOT NULL,
	"prev_sigma" double precision NOT NULL,
	"new_mu" double precision NOT NULL,
	"new_sigma" double precision NOT NULL,
	"signal_extracted" double precision,
	"signal_weight" double precision,
	"trigger_trade_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"payout" numeric(20, 8) NOT NULL,
	"theta_star" double precision NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_claim_position" UNIQUE("position_id")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"contract_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"contract_key" varchar(128) NOT NULL,
	"type" varchar(16) NOT NULL,
	"params" jsonb NOT NULL,
	"mm_short" numeric(20, 8) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_contract_market_key" UNIQUE("market_id","contract_key")
);
--> statement-breakpoint
CREATE TABLE "lp_ledger" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"shares_delta" numeric(20, 8) NOT NULL,
	"nav_before" numeric(20, 8) NOT NULL,
	"share_price" numeric(20, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lp_positions" (
	"lp_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"shares" numeric(20, 8) DEFAULT 0 NOT NULL,
	"total_deposited" numeric(20, 8) DEFAULT 0 NOT NULL,
	"total_withdrawn" numeric(20, 8) DEFAULT 0 NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_lp_market_user" UNIQUE("market_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"market_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"outcome_unit" varchar(20) NOT NULL,
	"outcome_min" double precision,
	"outcome_max" double precision,
	"status" varchar(16) DEFAULT 'CREATED' NOT NULL,
	"creator_id" uuid NOT NULL,
	"belief_kind" varchar(16) DEFAULT 'gaussian' NOT NULL,
	"initial_mu" double precision NOT NULL,
	"initial_sigma" double precision NOT NULL,
	"current_mu" double precision NOT NULL,
	"current_sigma" double precision NOT NULL,
	"cfg" jsonb NOT NULL,
	"cash" numeric(20, 8) DEFAULT 0 NOT NULL,
	"reserve_required" numeric(20, 8) DEFAULT 0 NOT NULL,
	"lp_shares_total" numeric(20, 8) DEFAULT 0 NOT NULL,
	"theta_star" double precision,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"resolves_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oracles" (
	"oracle_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"source" varchar(100) NOT NULL,
	"resolved_value" double precision NOT NULL,
	"confidence" double precision,
	"disputed" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"position_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"quantity" numeric(20, 8) DEFAULT 0 NOT NULL,
	"avg_entry_price" numeric(20, 8) DEFAULT 0 NOT NULL,
	"realized_pnl" numeric(20, 8) DEFAULT 0 NOT NULL,
	"peak_unrealized" numeric(20, 8) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_position_user_contract" UNIQUE("user_id","contract_id")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"trade_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"side" varchar(4) NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"exec_price" numeric(20, 8) NOT NULL,
	"fair_price" numeric(20, 8) NOT NULL,
	"spread_total" numeric(20, 8) NOT NULL,
	"total_cost" numeric(20, 8) NOT NULL,
	"belief_mu_before" double precision NOT NULL,
	"belief_sigma_before" double precision NOT NULL,
	"belief_mu_after" double precision NOT NULL,
	"belief_sigma_after" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"role" varchar(16) DEFAULT 'user' NOT NULL,
	"balance" numeric(20, 8) DEFAULT 0 NOT NULL,
	"is_infinite" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "belief_updates" ADD CONSTRAINT "belief_updates_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_position_id_positions_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("position_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_ledger" ADD CONSTRAINT "lp_ledger_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_ledger" ADD CONSTRAINT "lp_ledger_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD CONSTRAINT "lp_positions_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD CONSTRAINT "lp_positions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oracles" ADD CONSTRAINT "oracles_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_contract_id_contracts_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("contract_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_contract_id_contracts_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("contract_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_belief_market_time" ON "belief_updates" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_claim_user" ON "claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_contract_market" ON "contracts" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_lpledger_market_time" ON "lp_ledger" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_lp_user" ON "lp_positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_position_user" ON "positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_position_market" ON "positions" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_trade_market_time" ON "trades" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_trade_user" ON "trades" USING btree ("user_id");