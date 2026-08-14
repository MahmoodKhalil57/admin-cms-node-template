CREATE TABLE `entitlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`order_item_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`buyer_user_id` text,
	`buyer_email` text,
	`downloads_used` integer DEFAULT 0 NOT NULL,
	`download_limit` integer DEFAULT 5 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_order_item` ON `entitlements` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `entitlements_buyer` ON `entitlements` (`buyer_user_id`);--> statement-breakpoint
CREATE TABLE `product_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`object_key` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_assets_product` ON `product_assets` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`blurb` text,
	`price` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`vendor_id` integer,
	`download_limit` integer DEFAULT 5 NOT NULL,
	`download_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_vendor` ON `products` (`vendor_id`);