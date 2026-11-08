ALTER TABLE `deals` ADD COLUMN `epic_offers` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD COLUMN `region_locked` integer;
--> statement-breakpoint
ALTER TABLE `library_items` ADD COLUMN `device_platforms` text;
