ALTER TABLE `api_keys` ADD `scope_permissions` text DEFAULT 'null';--> statement-breakpoint
ALTER TABLE `api_keys` ADD `scope_conditions` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `scope_policies` text DEFAULT '[]' NOT NULL;