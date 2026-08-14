CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`actor_user_id` text,
	`via_key` integer DEFAULT false NOT NULL,
	`vendor_id` integer,
	`subject_type` text,
	`subject_id` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `events_created` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `events_vendor_created` ON `events` (`vendor_id`,`created_at`);