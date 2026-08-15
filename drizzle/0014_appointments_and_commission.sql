CREATE TABLE `availability_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer,
	`date` text NOT NULL,
	`start_minute` integer,
	`end_minute` integer,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `availability_exceptions_vendor` ON `availability_exceptions` (`vendor_id`,`date`);--> statement-breakpoint
CREATE TABLE `availability_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer,
	`weekday` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `availability_rules_vendor` ON `availability_rules` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `booking_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`booking_id` integer NOT NULL,
	`resource_key` text NOT NULL,
	`slot_start` integer NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_slots_unique` ON `booking_slots` (`resource_key`,`slot_start`);--> statement-breakpoint
CREATE INDEX `booking_slots_booking` ON `booking_slots` (`booking_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`service_id` integer NOT NULL,
	`vendor_id` integer,
	`buyer_user_id` text,
	`buyer_email` text,
	`buyer_name` text,
	`note` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`hold_expires_at` integer,
	`order_id` integer,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_reference_unique` ON `bookings` (`reference`);--> statement-breakpoint
CREATE INDEX `bookings_service_start` ON `bookings` (`service_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_vendor_start` ON `bookings` (`vendor_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_buyer` ON `bookings` (`buyer_user_id`);--> statement-breakpoint
CREATE INDEX `bookings_order` ON `bookings` (`order_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`blurb` text,
	`price` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`vendor_id` integer,
	`duration_minutes` integer DEFAULT 30 NOT NULL,
	`buffer_minutes` integer DEFAULT 0 NOT NULL,
	`horizon_days` integer DEFAULT 60 NOT NULL,
	`lead_minutes` integer DEFAULT 120 NOT NULL,
	`hold_minutes` integer DEFAULT 15 NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug_unique` ON `services` (`slug`);--> statement-breakpoint
CREATE INDEX `services_vendor` ON `services` (`vendor_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `commission_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `commission_bps` integer;