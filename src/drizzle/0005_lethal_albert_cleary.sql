ALTER TABLE `session` RENAME TO `evaluation_cases`;--> statement-breakpoint
ALTER TABLE `evaluation_cases` RENAME COLUMN "expires_at" TO "title";--> statement-breakpoint
ALTER TABLE `evaluation_cases` RENAME COLUMN "token" TO "description";--> statement-breakpoint
ALTER TABLE `evaluation_cases` RENAME COLUMN "ip_address" TO "user_message_json";--> statement-breakpoint
ALTER TABLE `evaluation_cases` RENAME COLUMN "user_agent" TO "eval_rule";--> statement-breakpoint
ALTER TABLE `evaluation_cases` RENAME COLUMN "user_id" TO "metadata_json";--> statement-breakpoint
CREATE TABLE `evaluation_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`parent_context_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`child_count` integer DEFAULT 0 NOT NULL,
	`environment_json` text DEFAULT '{}' NOT NULL,
	`headers_json` text DEFAULT '{}' NOT NULL,
	`recent_messages_json` text DEFAULT '[]' NOT NULL,
	`context_summary` text,
	`created_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL,
	`updated_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL,
	FOREIGN KEY (`parent_context_id`) REFERENCES `evaluation_contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluation_contexts_parent_idx` ON `evaluation_contexts` (`parent_context_id`);--> statement-breakpoint
CREATE INDEX `evaluation_contexts_depth_idx` ON `evaluation_contexts` (`depth`);--> statement-breakpoint
CREATE TABLE `evaluation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`context_id` text NOT NULL,
	`case_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`request_payload` text NOT NULL,
	`response_json` text NOT NULL,
	`result_overview` text,
	`score` integer,
	`latency_ms` integer,
	`started_at` integer,
	`completed_at` integer,
	`error` text,
	`created_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `evaluation_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_id`) REFERENCES `evaluation_contexts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `evaluation_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evaluation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`notes` text,
	`agent_base_url` text,
	`created_by` text,
	`created_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL,
	`updated_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL
);
--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
DROP TABLE `todos`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
DROP TABLE `verification`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_evaluation_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`root_context_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`user_message_json` text NOT NULL,
	`eval_rule` text,
	`metadata_json` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL,
	`updated_at` integer DEFAULT cast((julianday('now') - 2440587.5) * 86400000 as integer) NOT NULL,
	FOREIGN KEY (`root_context_id`) REFERENCES `evaluation_contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_evaluation_cases`("id", "root_context_id", "title", "description", "user_message_json", "eval_rule", "metadata_json", "order_index", "created_at", "updated_at") SELECT "id", "root_context_id", "title", "description", "user_message_json", "eval_rule", "metadata_json", "order_index", "created_at", "updated_at" FROM `evaluation_cases`;--> statement-breakpoint
DROP TABLE `evaluation_cases`;--> statement-breakpoint
ALTER TABLE `__new_evaluation_cases` RENAME TO `evaluation_cases`;--> statement-breakpoint
PRAGMA foreign_keys=ON;