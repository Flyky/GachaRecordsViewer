PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gacha_records` (
	`owner_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`record_id` text NOT NULL,
	`item_id` text,
	`gacha_type` text NOT NULL,
	`pity_group` text NOT NULL,
	`time_local` text NOT NULL,
	`time_utc` text NOT NULL,
	`name` text,
	`item_type` text,
	`rank` integer,
	`source` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`profile_id`, `record_id`),
	FOREIGN KEY (`owner_id`,`profile_id`) REFERENCES `game_profiles`(`owner_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "records_rank_valid" CHECK("__new_gacha_records"."rank" IS NULL OR "__new_gacha_records"."rank" IN (3, 4, 5))
);
--> statement-breakpoint
INSERT INTO `__new_gacha_records`("owner_id", "profile_id", "record_id", "item_id", "gacha_type", "pity_group", "time_local", "time_utc", "name", "item_type", "rank", "source", "metadata_json") SELECT "owner_id", "profile_id", "record_id", "item_id", "gacha_type", "pity_group", "time_local", "time_utc", "name", "item_type", "rank", "source", "metadata_json" FROM `gacha_records`;--> statement-breakpoint
DROP TABLE `gacha_records`;--> statement-breakpoint
ALTER TABLE `__new_gacha_records` RENAME TO `gacha_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `records_owner_profile_time_idx` ON `gacha_records` (`owner_id`,`profile_id`,`time_utc`);--> statement-breakpoint
CREATE INDEX `records_owner_pool_idx` ON `gacha_records` (`owner_id`,`profile_id`,`pity_group`);