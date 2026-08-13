CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`rate_per_minute` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `api_keys_prefix` ON `api_keys` (`prefix`);