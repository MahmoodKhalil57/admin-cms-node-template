CREATE TABLE `payouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`currency` text NOT NULL,
	`gross` integer NOT NULL,
	`fee_estimate` integer DEFAULT 0 NOT NULL,
	`fee_actual` integer,
	`net` integer NOT NULL,
	`transfer_id` text,
	`provider_payout_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`failure_reason` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_idempotency` ON `payouts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `payouts_vendor` ON `payouts` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `vendor_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`order_item_id` integer,
	`payout_id` integer,
	`note` text,
	`dedupe_key` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_ledger_dedupe` ON `vendor_ledger` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `vendor_ledger_vendor` ON `vendor_ledger` (`vendor_id`);--> statement-breakpoint
ALTER TABLE `payment_providers` ADD `payout_fee_fixed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_providers` ADD `payout_fee_basis_points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_providers` ADD `payout_minimum` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `stripe_account_id` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `onboarding_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `payouts_enabled` integer DEFAULT false NOT NULL;