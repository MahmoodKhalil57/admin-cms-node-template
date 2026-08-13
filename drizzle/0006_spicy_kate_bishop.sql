CREATE TABLE `policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`effect` text DEFAULT 'allow' NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`condition` text DEFAULT '{}' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policies_key_unique` ON `policies` (`key`);--> statement-breakpoint
ALTER TABLE `roles` ADD `policies` text DEFAULT '[]' NOT NULL;