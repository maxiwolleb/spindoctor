CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`action` text NOT NULL,
	`drive_serial` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `config` (
	`id` integer PRIMARY KEY NOT NULL,
	`thresholds` text NOT NULL,
	`concurrency` integer DEFAULT 4 NOT NULL,
	`auto_mode_enabled` integer DEFAULT false NOT NULL,
	`protect_list` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drives` (
	`serial` text PRIMARY KEY NOT NULL,
	`wwn` text,
	`model` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`type` text NOT NULL,
	`transport` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`protected` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `smart_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`phase` text NOT NULL,
	`raw` text NOT NULL,
	`key_metrics` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stage_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`log_path` text,
	`metrics` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drive_serial` text NOT NULL,
	`regime` text NOT NULL,
	`status` text NOT NULL,
	`verdict` text,
	`reasons` text,
	`current_stage` text,
	`restart_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`drive_serial`) REFERENCES `drives`(`serial`) ON UPDATE no action ON DELETE no action
);
