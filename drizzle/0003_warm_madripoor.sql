CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`event` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`when` text DEFAULT '{}' NOT NULL,
	`audience` text DEFAULT '{}' NOT NULL,
	`channels` text DEFAULT '["email"]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` integer,
	`subject_type` text DEFAULT 'submission' NOT NULL,
	`subject_id` integer,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`user_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`detail` text,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `notifications_user_read` ON `notifications` (`user_id`,`read_at`);