CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`content` text NOT NULL,
	`state` text NOT NULL,
	`pinned` integer NOT NULL,
	`source` text NOT NULL,
	`source_thread_id` text,
	`source_run_id` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`confirmed_at` text,
	`expires_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memories_workspace_state` ON `memories` (`workspace_id`,`state`);--> statement-breakpoint
CREATE TABLE `model_histories` (
	`run_id` text PRIMARY KEY NOT NULL,
	`messages` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `model_settings` ADD `context_window_tokens` integer DEFAULT 32768 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_settings` ADD `max_output_tokens` integer DEFAULT 4096 NOT NULL;