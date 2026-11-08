CREATE TABLE accounts (
  platform TEXT PRIMARY KEY,
  display_name TEXT,
  account_ref TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  steam_api_key TEXT,
  last_sync_at INTEGER,
  last_sync_note TEXT,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE library_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  playtime_minutes INTEGER,
  source TEXT NOT NULL DEFAULT 'sync',
  ext_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX library_items_platform_source_key_idx ON library_items (platform, source, ext_key);
--> statement-breakpoint
CREATE TABLE app_watch (
  track_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon_url TEXT,
  store_url TEXT,
  deal_external_id TEXT
);
--> statement-breakpoint
CREATE TABLE app_price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  snapshot_date TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX app_price_snapshots_track_date_idx ON app_price_snapshots (track_id, snapshot_date);
