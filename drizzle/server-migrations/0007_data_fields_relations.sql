-- Notion-like fields and views: URL, email, phone, multi-select, person and relation
-- fields, and the gallery layout. Every scalar type keeps its typed slot column;
-- relation values are rows of database_item_links, keyed by field and record.
-- SQLite cannot widen a CHECK constraint in place, so the two constrained tables
-- are rebuilt with their rows, indexes and triggers intact. The trigger that gives
-- a new database its first view must not reference the table while it is rebuilt.
DROP TRIGGER `database_default_view_after_insert`;
--> statement-breakpoint
CREATE TABLE `database_fields_next` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`slot` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "database_fields_type_check" CHECK("database_fields_next"."type" in ('text', 'number', 'boolean', 'date', 'select', 'multi_select', 'url', 'email', 'phone', 'person', 'relation'))
);
--> statement-breakpoint
INSERT INTO `database_fields_next` (`id`, `database_id`, `name`, `type`, `slot`, `config_json`, `position`, `created_by`, `created_at`, `updated_at`)
SELECT `id`, `database_id`, `name`, `type`, `slot`, `config_json`, `position`, `created_by`, `created_at`, `updated_at` FROM `database_fields`;
--> statement-breakpoint
DROP TABLE `database_fields`;
--> statement-breakpoint
ALTER TABLE `database_fields_next` RENAME TO `database_fields`;
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_name_unique` ON `database_fields` (`database_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_slot_unique` ON `database_fields` (`database_id`,`type`,`slot`);
--> statement-breakpoint
CREATE INDEX `database_fields_position_idx` ON `database_fields` (`database_id`,`position`);
--> statement-breakpoint
CREATE TABLE `database_views_next` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` text NOT NULL,
	`name` text NOT NULL,
	`layout` text DEFAULT 'table' NOT NULL,
	`config_json` text DEFAULT '{"visibleFieldIds":null,"filters":[],"sorts":[{"fieldId":"title","direction":"asc"}],"groupFieldId":null,"dateFieldId":null}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "database_views_layout_check" CHECK("database_views_next"."layout" in ('table', 'board', 'calendar', 'list', 'gallery')),
	CONSTRAINT "database_views_version_check" CHECK("database_views_next"."version" > 0)
);
--> statement-breakpoint
INSERT INTO `database_views_next` (`id`, `database_id`, `name`, `layout`, `config_json`, `position`, `version`, `created_by`, `created_at`, `updated_at`)
SELECT `id`, `database_id`, `name`, `layout`, `config_json`, `position`, `version`, `created_by`, `created_at`, `updated_at` FROM `database_views`;
--> statement-breakpoint
DROP TABLE `database_views`;
--> statement-breakpoint
ALTER TABLE `database_views_next` RENAME TO `database_views`;
--> statement-breakpoint
CREATE UNIQUE INDEX `database_views_name_unique` ON `database_views` (`database_id`,`name`);
--> statement-breakpoint
CREATE INDEX `database_views_database_position_idx` ON `database_views` (`database_id`,`position`);
--> statement-breakpoint
CREATE TRIGGER `database_default_view_after_insert` AFTER INSERT ON `database_definitions` BEGIN
  INSERT INTO `database_views` (`id`, `database_id`, `name`, `layout`, `position`, `created_by`, `created_at`, `updated_at`)
  VALUES ('default:' || NEW.`id`, NEW.`id`, 'All records', 'table', 1024, NEW.`created_by`, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `database_view_bookmarks_after_delete` AFTER DELETE ON `database_views` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'database_view' AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TABLE `database_item_links` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`item_id` text NOT NULL,
	`target_item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `database_fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `database_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_item_id`) REFERENCES `database_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_item_links_unique` ON `database_item_links` (`field_id`,`item_id`,`target_item_id`);
--> statement-breakpoint
CREATE INDEX `database_item_links_item_idx` ON `database_item_links` (`item_id`,`field_id`,`position`);
--> statement-breakpoint
CREATE INDEX `database_item_links_target_idx` ON `database_item_links` (`target_item_id`);
