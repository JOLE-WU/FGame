CREATE TABLE users (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_username_idx ON users (username);
--> statement-breakpoint
CREATE TABLE sessions (
  token text PRIMARY KEY NOT NULL,
  user_id integer NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE marks ADD COLUMN user_id integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS marks_deal_kind_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX marks_deal_kind_user_idx ON marks (deal_id, kind, user_id);
--> statement-breakpoint
ALTER TABLE library_items ADD COLUMN user_id integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS library_items_platform_source_key_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX library_items_platform_source_key_user_idx ON library_items (platform, source, ext_key, user_id);
--> statement-breakpoint
CREATE TABLE accounts_new (
  user_id integer DEFAULT 0 NOT NULL,
  platform text NOT NULL,
  display_name text,
  account_ref text,
  access_token text,
  refresh_token text,
  expires_at integer,
  steam_api_key text,
  last_sync_at integer,
  last_sync_note text,
  updated_at integer NOT NULL,
  PRIMARY KEY (user_id, platform)
);
--> statement-breakpoint
INSERT INTO accounts_new (user_id, platform, display_name, account_ref, access_token, refresh_token, expires_at, steam_api_key, last_sync_at, last_sync_note, updated_at)
SELECT 0, platform, display_name, account_ref, access_token, refresh_token, expires_at, steam_api_key, last_sync_at, last_sync_note, updated_at FROM accounts;
--> statement-breakpoint
DROP TABLE accounts;
--> statement-breakpoint
ALTER TABLE accounts_new RENAME TO accounts;
