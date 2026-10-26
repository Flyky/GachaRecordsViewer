CREATE TABLE "app_state" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"admin_fingerprint" text NOT NULL,
	"admin_session_version" text NOT NULL,
	CONSTRAINT "app_state_singleton" CHECK ("app_state"."id" = 'primary')
);
--> statement-breakpoint
CREATE TABLE "community_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"mid" text,
	"nickname" text,
	"capabilities_json" text DEFAULT '{}' NOT NULL,
	CONSTRAINT "community_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "community_identity_unique" UNIQUE("owner_id","provider","account_id"),
	CONSTRAINT "community_provider_valid" CHECK ("community_accounts"."provider" IN ('cn', 'os'))
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"community_account_id" text NOT NULL,
	"type" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	CONSTRAINT "credentials_account_type_unique" UNIQUE("owner_id","community_account_id","type")
);
--> statement-breakpoint
CREATE TABLE "gacha_records" (
	"owner_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"record_id" text NOT NULL,
	"item_id" text NOT NULL,
	"gacha_type" text NOT NULL,
	"pity_group" text NOT NULL,
	"time_local" text NOT NULL,
	"time_utc" text NOT NULL,
	"name" text,
	"item_type" text,
	"rank" integer,
	"source" text NOT NULL,
	CONSTRAINT "gacha_records_profile_id_record_id_pk" PRIMARY KEY("profile_id","record_id"),
	CONSTRAINT "records_rank_valid" CHECK ("gacha_records"."rank" IS NULL OR "gacha_records"."rank" IN (3, 4, 5))
);
--> statement-breakpoint
CREATE TABLE "game_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"game" text NOT NULL,
	"uid" text NOT NULL,
	"region" text DEFAULT 'unknown' NOT NULL,
	"timezone" integer NOT NULL,
	"lang" text,
	"community_account_id" text,
	"history_status" text DEFAULT 'unknown' NOT NULL,
	"data_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "profiles_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "profiles_identity_unique" UNIQUE("owner_id","game","uid","region"),
	CONSTRAINT "profiles_timezone_valid" CHECK ("game_profiles"."timezone" BETWEEN -12 AND 14),
	CONSTRAINT "profiles_game_valid" CHECK ("game_profiles"."game" IN ('hk4e', 'hkrpg', 'nap'))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"file_hash" text NOT NULL,
	"status" text NOT NULL,
	"result_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_metadata" (
	"game" text NOT NULL,
	"item_id" text NOT NULL,
	"item_type" text,
	"rank" integer,
	"names_json" text DEFAULT '{}' NOT NULL,
	"source_version" text NOT NULL,
	CONSTRAINT "item_metadata_game_item_id_pk" PRIMARY KEY("game","item_id"),
	CONSTRAINT "metadata_rank_valid" CHECK ("item_metadata"."rank" IS NULL OR "item_metadata"."rank" IN (3, 4, 5))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_id" text,
	"auth_version" text NOT NULL,
	"expires_at" text NOT NULL,
	CONSTRAINT "sessions_subject_valid" CHECK (("sessions"."kind" = 'admin' AND "sessions"."owner_id" IS NULL) OR ("sessions"."kind" = 'user' AND "sessions"."owner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"status" text NOT NULL,
	"progress_json" text DEFAULT '{}' NOT NULL,
	"failure_code" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_initial_password" integer DEFAULT 1 NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_initial_boolean" CHECK ("users"."is_initial_password" IN (0, 1)),
	CONSTRAINT "users_session_version_positive" CHECK ("users"."session_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "community_accounts" ADD CONSTRAINT "community_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_id_community_account_id_community_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","community_account_id") REFERENCES "public"."community_accounts"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gacha_records" ADD CONSTRAINT "gacha_records_owner_id_profile_id_game_profiles_owner_id_id_fk" FOREIGN KEY ("owner_id","profile_id") REFERENCES "public"."game_profiles"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_profiles" ADD CONSTRAINT "game_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_profiles" ADD CONSTRAINT "game_profiles_owner_id_community_account_id_community_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","community_account_id") REFERENCES "public"."community_accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_owner_id_profile_id_game_profiles_owner_id_id_fk" FOREIGN KEY ("owner_id","profile_id") REFERENCES "public"."game_profiles"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "records_owner_profile_time_idx" ON "gacha_records" USING btree ("owner_id","profile_id","time_utc");--> statement-breakpoint
CREATE INDEX "records_owner_pool_idx" ON "gacha_records" USING btree ("owner_id","profile_id","pity_group");--> statement-breakpoint
CREATE INDEX "imports_owner_idx" ON "import_batches" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "jobs_owner_profile_idx" ON "sync_jobs" USING btree ("owner_id","profile_id");