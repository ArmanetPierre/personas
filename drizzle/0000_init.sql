CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`country` text NOT NULL,
	`pack_version` text NOT NULL,
	`seed` integer,
	`age` integer NOT NULL,
	`sex` text NOT NULL,
	`region` text NOT NULL,
	`town_size` text NOT NULL,
	`occupation` text NOT NULL,
	`monthly_income_eur` integer NOT NULL,
	`monthly_discretionary_budget_eur` integer NOT NULL,
	`household_type` text NOT NULL,
	`tech_adoption` text NOT NULL,
	`price_sensitivity` real NOT NULL,
	`skepticism` real NOT NULL,
	`social_media_usage` text NOT NULL,
	`equipment` text DEFAULT '[]' NOT NULL,
	`subscriptions` text DEFAULT '[]' NOT NULL,
	`extra` text DEFAULT '{}' NOT NULL,
	`narrative` text,
	`narrative_backend` text,
	`narrative_model` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `personas_country_idx` ON `personas` (`country`,`pack_version`);--> statement-breakpoint
CREATE INDEX `personas_age_idx` ON `personas` (`age`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pitch` text NOT NULL,
	`target_audience` text,
	`business_model` text,
	`price_eur` real,
	`price_period` text,
	`competitors` text DEFAULT '[]' NOT NULL,
	`alternatives` text DEFAULT '[]' NOT NULL,
	`extra` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`format` text DEFAULT 'markdown' NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`aggregates` text,
	`file_path` text,
	`backend` text,
	`model` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`study_id`) REFERENCES `studies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reports_study_idx` ON `reports` (`study_id`);--> statement-breakpoint
CREATE TABLE `responses` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`question_key` text NOT NULL,
	`payload` text NOT NULL,
	`raw_text` text,
	`backend` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`duration_ms` integer NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`study_id`) REFERENCES `studies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `responses_study_persona_question_uq` ON `responses` (`study_id`,`persona_id`,`question_key`);--> statement-breakpoint
CREATE TABLE `studies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`protocol_version` text DEFAULT '1' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`backend` text NOT NULL,
	`model` text NOT NULL,
	`seed` integer NOT NULL,
	`sample_size` integer NOT NULL,
	`quotas` text DEFAULT '{}' NOT NULL,
	`persona_ids` text DEFAULT '[]' NOT NULL,
	`progress_done` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `studies_project_idx` ON `studies` (`project_id`);