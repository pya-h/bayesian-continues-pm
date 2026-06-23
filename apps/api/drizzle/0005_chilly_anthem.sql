CREATE TABLE "market_cfg_history" (
	"cfg_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"sigma_eps" double precision NOT NULL,
	"s0" double precision NOT NULL,
	"alpha" double precision NOT NULL,
	"beta" double precision NOT NULL,
	"regime" double precision NOT NULL,
	"rail_hit" boolean DEFAULT false NOT NULL,
	"source" varchar(16) NOT NULL,
	"trigger_trade_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "cfg_state" jsonb;--> statement-breakpoint
ALTER TABLE "market_cfg_history" ADD CONSTRAINT "market_cfg_history_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cfg_history_market_time" ON "market_cfg_history" USING btree ("market_id","created_at");