DROP INDEX IF EXISTS `personas_draw_uq`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `personas_draw_idx` ON `personas` (`pack_version`,`seed`,`draw_index`);
