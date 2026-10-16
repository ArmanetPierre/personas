ALTER TABLE `projects` ADD `free_offer` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `narrative_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `repaired` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `anomalies` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `studies` ADD `sample_from_study_id` text;