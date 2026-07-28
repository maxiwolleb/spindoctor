ALTER TABLE `config` ADD `diagnostics_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `config` ADD `diagnostics_include_serials` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `config` ADD `diagnostics_salt` text;