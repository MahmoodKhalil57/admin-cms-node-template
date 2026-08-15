CREATE TABLE `vendor_credits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`kind` text NOT NULL,
	`credits` integer NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`note` text,
	`dedupe_key` text,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_credits_dedupe_key_unique` ON `vendor_credits` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `vendor_credits_vendor` ON `vendor_credits` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `vendor_meters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`period` text NOT NULL,
	`item` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`credits` integer DEFAULT 0 NOT NULL,
	`price_list_version` integer DEFAULT 1 NOT NULL,
	`reported_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_meters_unique` ON `vendor_meters` (`vendor_id`,`period`,`item`);--> statement-breakpoint
CREATE TABLE `vendor_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`credits` integer NOT NULL,
	`price` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_packages_key_unique` ON `vendor_packages` (`key`);--> statement-breakpoint
CREATE INDEX `vendor_packages_active` ON `vendor_packages` (`active`);