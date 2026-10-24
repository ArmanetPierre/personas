CREATE TABLE `engine_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`study_id` text,
	`day` text NOT NULL,
	`month` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`reported_cost_usd` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_usage_study_idx` ON `engine_usage` (`study_id`);--> statement-breakpoint
CREATE INDEX `engine_usage_profile_day_idx` ON `engine_usage` (`profile`,`day`);--> statement-breakpoint
CREATE INDEX `engine_usage_profile_month_idx` ON `engine_usage` (`profile`,`month`);--> statement-breakpoint
ALTER TABLE `studies` ADD `extra` text DEFAULT '{}' NOT NULL;