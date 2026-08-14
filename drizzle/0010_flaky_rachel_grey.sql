CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`name` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_amount` integer DEFAULT 0 NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`vendor_id` integer,
	`vendor_share` integer DEFAULT 0 NOT NULL,
	`platform_fee` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_items_order` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`buyer_user_id` text,
	`buyer_email` text,
	`currency` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_key` text NOT NULL,
	`provider_ref` text,
	`payment_intent_id` text,
	`transfer_group` text,
	`paid_at` integer,
	`refunded_total` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_reference_unique` ON `orders` (`reference`);--> statement-breakpoint
CREATE INDEX `orders_provider_ref` ON `orders` (`provider_ref`);--> statement-breakpoint
CREATE INDEX `orders_buyer` ON `orders` (`buyer_user_id`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_key` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`applied_at` integer,
	`result` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_unique` ON `payment_events` (`provider_key`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `payment_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`publishable_key` text,
	`secret_key` text,
	`webhook_secret` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_providers_key_unique` ON `payment_providers` (`key`);