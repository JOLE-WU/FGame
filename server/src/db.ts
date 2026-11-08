/** FGame standalone database: Node + better-sqlite3 + Drizzle ORM.
 *  Drizzle migrations from /drizzle are applied once, in filename order. */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.FGAME_DB ?? "./fgame.db";
const abs = isAbsolute(DB_PATH) ? DB_PATH : resolve(process.cwd(), DB_PATH);
mkdirSync(dirname(abs), { recursive: true });

export const sqlite = new Database(abs);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

/** Apply migrations idempotently. A column/index that already exists is
 *  tolerated so re-deploys against an older volume don't abort startup. */
export function runMigrations(drizzleDir: string): string[] {
  const applied: string[] = [];
  if (!existsSync(drizzleDir)) return applied;
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __fgame_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    (sqlite.prepare("SELECT name FROM __fgame_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(drizzleDir, f), "utf8");
    try {
      sqlite.exec(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column|already exists|no such table/i.test(msg)) throw e;
    }
    sqlite.prepare("INSERT OR REPLACE INTO __fgame_migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now());
    applied.push(f);
  }
  return applied;
}
