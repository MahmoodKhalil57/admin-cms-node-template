ALTER TABLE `form_submissions` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `target` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `forms` ADD `required_at_signup` integer DEFAULT false NOT NULL;