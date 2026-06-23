CREATE TABLE "disputes" (
	"dispute_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"proposed_value" double precision,
	"secondary_value" double precision,
	"resolver_id" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "oracle_mode" varchar(16) DEFAULT 'centralized' NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "oracle_user_id" uuid;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "oracle_token" varchar(32);--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "dispute_window_sec" integer DEFAULT 86400 NOT NULL;--> statement-breakpoint
ALTER TABLE "oracles" ADD COLUMN "token" varchar(32);--> statement-breakpoint
ALTER TABLE "oracles" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolver_id_users_user_id_fk" FOREIGN KEY ("resolver_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dispute_market" ON "disputes" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_dispute_status" ON "disputes" USING btree ("status");--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_oracle_user_id_users_user_id_fk" FOREIGN KEY ("oracle_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oracle_market" ON "oracles" USING btree ("market_id");