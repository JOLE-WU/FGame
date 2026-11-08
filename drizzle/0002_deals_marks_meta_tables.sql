DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT 'other',
  platform TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  worth_cents INTEGER,
  image_url TEXT,
  claim_url TEXT,
  instructions TEXT,
  published_at INTEGER,
  end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  users_count INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX deals_external_id_idx ON deals (external_id);
--> statement-breakpoint
CREATE TABLE marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX marks_deal_kind_idx ON marks (deal_id, kind);
--> statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
