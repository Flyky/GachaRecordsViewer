CREATE TABLE `app_state` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`admin_fingerprint` text NOT NULL,
	`admin_session_version` text NOT NULL,
	CONSTRAINT "app_state_singleton" CHECK("app_state"."id" = 'primary')
);
--> statement-breakpoint
CREATE TABLE `community_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`mid` text,
	`nickname` text,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "community_provider_valid" CHECK("community_accounts"."provider" IN ('cn', 'os'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_owner_id_unique` ON `community_accounts` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `community_identity_unique` ON `community_accounts` (`owner_id`,`provider`,`account_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`community_account_id` text NOT NULL,
	`type` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	FOREIGN KEY (`owner_id`,`community_account_id`) REFERENCES `community_accounts`(`owner_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_account_type_unique` ON `credentials` (`owner_id`,`community_account_id`,`type`);--> statement-breakpoint
CREATE TABLE `gacha_records` (
	`owner_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`record_id` text NOT NULL,
	`item_id` text NOT NULL,
	`gacha_type` text NOT NULL,
	`pity_group` text NOT NULL,
	`time_local` text NOT NULL,
	`time_utc` text NOT NULL,
	`name` text,
	`item_type` text,
	`rank` integer,
	`source` text NOT NULL,
	PRIMARY KEY(`profile_id`, `record_id`),
	FOREIGN KEY (`owner_id`,`profile_id`) REFERENCES `game_profiles`(`owner_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "records_rank_valid" CHECK("gacha_records"."rank" IS NULL OR "gacha_records"."rank" IN (3, 4, 5))
);
--> statement-breakpoint
CREATE INDEX `records_owner_profile_time_idx` ON `gacha_records` (`owner_id`,`profile_id`,`time_utc`);--> statement-breakpoint
CREATE INDEX `records_owner_pool_idx` ON `gacha_records` (`owner_id`,`profile_id`,`pity_group`);--> statement-breakpoint
CREATE TABLE `game_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`game` text NOT NULL,
	`uid` text NOT NULL,
	`region` text DEFAULT 'unknown' NOT NULL,
	`timezone` integer NOT NULL,
	`lang` text,
	`community_account_id` text,
	`history_status` text DEFAULT 'unknown' NOT NULL,
	`data_version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`,`community_account_id`) REFERENCES `community_accounts`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "profiles_timezone_valid" CHECK("game_profiles"."timezone" BETWEEN -12 AND 14),
	CONSTRAINT "profiles_game_valid" CHECK("game_profiles"."game" IN ('hk4e', 'hkrpg', 'nap'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_owner_id_unique` ON `game_profiles` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_identity_unique` ON `game_profiles` (`owner_id`,`game`,`uid`,`region`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `imports_owner_idx` ON `import_batches` (`owner_id`);--> statement-breakpoint
CREATE TABLE `item_metadata` (
	`game` text NOT NULL,
	`item_id` text NOT NULL,
	`item_type` text,
	`rank` integer,
	`names_json` text DEFAULT '{}' NOT NULL,
	`source_version` text NOT NULL,
	PRIMARY KEY(`game`, `item_id`),
	CONSTRAINT "metadata_rank_valid" CHECK("item_metadata"."rank" IS NULL OR "item_metadata"."rank" IN (3, 4, 5))
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text,
	`auth_version` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_subject_valid" CHECK(("sessions"."kind" = 'admin' AND "sessions"."owner_id" IS NULL) OR ("sessions"."kind" = 'user' AND "sessions"."owner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `sessions_owner_idx` ON `sessions` (`owner_id`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`status` text NOT NULL,
	`progress_json` text DEFAULT '{}' NOT NULL,
	`failure_code` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`,`profile_id`) REFERENCES `game_profiles`(`owner_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_owner_profile_idx` ON `sync_jobs` (`owner_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_initial_password` integer DEFAULT 1 NOT NULL,
	`session_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "users_initial_boolean" CHECK("users"."is_initial_password" IN (0, 1)),
	CONSTRAINT "users_session_version_positive" CHECK("users"."session_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);