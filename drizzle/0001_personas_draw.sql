ALTER TABLE `personas` ADD `draw_index` integer;--> statement-breakpoint
ALTER TABLE `personas` ADD `first_name` text;--> statement-breakpoint
ALTER TABLE `personas` ADD `activity_status` text;--> statement-breakpoint
ALTER TABLE `personas` ADD `pcs` text;--> statement-breakpoint
ALTER TABLE `personas` ADD `household_income_eur` integer;--> statement-breakpoint
ALTER TABLE `personas` ADD `household_size` integer;--> statement-breakpoint
ALTER TABLE `personas` ADD `narrative_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `personas_draw_uq` ON `personas` (`pack_version`,`seed`,`draw_index`);