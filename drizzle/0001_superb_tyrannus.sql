CREATE TABLE `repo_hooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hook_id` integer NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
