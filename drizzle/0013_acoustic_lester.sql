CREATE TABLE `infra_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`access_token` text NOT NULL,
	`account_id` text,
	`account_name` text,
	`login` text,
	`scopes` text DEFAULT '[]' NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `infra_connections_provider` ON `infra_connections` (`provider`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`cloudflare_account_id` text,
	`worker_name` text,
	`hostname` text,
	`d1_database_id` text,
	`r2_bucket` text,
	`kv_namespace_id` text,
	`image_version` text,
	`owner_user_id` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `projects_owner` ON `projects` (`owner_user_id`);