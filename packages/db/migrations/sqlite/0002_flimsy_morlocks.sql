CREATE TABLE `payment_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`public_json` text NOT NULL,
	`encrypted_value` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payment_orders_owner_created_idx` ON `payment_orders` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shared_snapshots` (
	`key` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL
);
