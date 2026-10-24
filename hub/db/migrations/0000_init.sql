CREATE SCHEMA IF NOT EXISTS "personas_hub";
--> statement-breakpoint
CREATE TABLE "personas_hub"."module_deps" (
	"version_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"version" text NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "module_deps_version_id_alias_pk" PRIMARY KEY("version_id","alias")
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."module_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"version" text NOT NULL,
	"yaml" text NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"applies_to" text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"attributes" jsonb NOT NULL,
	"requires" jsonb NOT NULL,
	"license" text DEFAULT 'CC-BY-4.0' NOT NULL,
	"engine_min" text,
	"quality" jsonb,
	"preview" jsonb,
	"search_title" text NOT NULL,
	"search_body" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('french', coalesce(search_title, '')), 'A') || setweight(to_tsvector('english', coalesce(search_title, '')), 'A') || setweight(to_tsvector('french', coalesce(search_body, '')), 'B') || setweight(to_tsvector('english', coalesce(search_body, '')), 'B')) STORED NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"forked_from_version_id" uuid,
	"star_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."namespaces" (
	"slug" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."pack_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"version" text NOT NULL,
	"extends" text,
	"files" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text NOT NULL,
	"license" text DEFAULT 'CC-BY-4.0' NOT NULL,
	"engine_min" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas_hub"."packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"country" text NOT NULL,
	"locale" text NOT NULL,
	"generator" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personas_hub"."module_deps" ADD CONSTRAINT "module_deps_version_id_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "personas_hub"."module_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."module_versions" ADD CONSTRAINT "module_versions_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "personas_hub"."modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."modules" ADD CONSTRAINT "modules_namespace_namespaces_slug_fk" FOREIGN KEY ("namespace") REFERENCES "personas_hub"."namespaces"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."pack_versions" ADD CONSTRAINT "pack_versions_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "personas_hub"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas_hub"."packs" ADD CONSTRAINT "packs_namespace_namespaces_slug_fk" FOREIGN KEY ("namespace") REFERENCES "personas_hub"."namespaces"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "module_versions_module_version" ON "personas_hub"."module_versions" USING btree ("module_id","version");--> statement-breakpoint
CREATE INDEX "module_versions_search" ON "personas_hub"."module_versions" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "modules_ns_slug" ON "personas_hub"."modules" USING btree ("namespace","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_versions_pack_version" ON "personas_hub"."pack_versions" USING btree ("pack_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "packs_ns_slug" ON "personas_hub"."packs" USING btree ("namespace","slug");