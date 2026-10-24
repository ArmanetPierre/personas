CREATE TABLE "personas_hub"."api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"interval_sec" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"token_id" uuid
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"evidence" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating" CHECK ("personas_hub"."reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."stars" (
	"user_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stars_user_id_module_id_pk" PRIMARY KEY("user_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."usage_daily" (
	"version_id" uuid NOT NULL,
	"day" date NOT NULL,
	"installs" integer DEFAULT 0 NOT NULL,
	"studies" integer DEFAULT 0 NOT NULL,
	"personas" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_version_id_day_pk" PRIMARY KEY("version_id","day")
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."usage_installs" (
	"version_id" uuid NOT NULL,
	"day" date NOT NULL,
	"install_hash" text NOT NULL,
	CONSTRAINT "usage_installs_version_id_day_install_hash_pk" PRIMARY KEY("version_id","day","install_hash")
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"github_id" text,
	"github_login" text,
	"role" text DEFAULT 'user' NOT NULL,
	"namespace" text NOT NULL,
	"namespace_changed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD COLUMN "signature_kid" text;--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD COLUMN "lint" jsonb;--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD COLUMN "sensitive" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "personas_hub"."pack_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "personas_hub"."pack_versions" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "personas_hub"."pack_versions" ADD COLUMN "signature_kid" text;--> statement-breakpoint
ALTER TABLE "personas_hub"."api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."device_codes" ADD CONSTRAINT "device_codes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."device_codes" ADD CONSTRAINT "device_codes_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "personas_hub"."api_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."moderation_events" ADD CONSTRAINT "moderation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."reviews" ADD CONSTRAINT "reviews_version_id_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "personas_hub"."module_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."stars" ADD CONSTRAINT "stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."stars" ADD CONSTRAINT "stars_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "personas_hub"."modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."usage_daily" ADD CONSTRAINT "usage_daily_version_id_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "personas_hub"."module_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."usage_installs" ADD CONSTRAINT "usage_installs_version_id_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "personas_hub"."module_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash" ON "personas_hub"."api_tokens" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user" ON "personas_hub"."api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_codes_hash" ON "personas_hub"."device_codes" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "device_codes_user_code" ON "personas_hub"."device_codes" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "moderation_events_target" ON "personas_hub"."moderation_events" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_target" ON "personas_hub"."reports" USING btree ("reporter_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "reports_target" ON "personas_hub"."reports" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_user_version" ON "personas_hub"."reviews" USING btree ("user_id","version_id");--> statement-breakpoint
CREATE INDEX "reviews_version" ON "personas_hub"."reviews" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email" ON "personas_hub"."users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_namespace" ON "personas_hub"."users" USING btree ("namespace");--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD CONSTRAINT "module_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."modules" ADD CONSTRAINT "modules_forked_from_version_id_module_versions_id_fk" FOREIGN KEY ("forked_from_version_id") REFERENCES "personas_hub"."module_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."namespaces" ADD CONSTRAINT "namespaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."pack_versions" ADD CONSTRAINT "pack_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "personas_hub"."users"("id") ON DELETE no action ON UPDATE no action;