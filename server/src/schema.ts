import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// In-app accounts (real registration/login). Passwords are stored ONLY as a
// salted PBKDF2 hash ("pbkdf2:<iterations>:<saltHex>:<hashHex>"), never plain.
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    // Avatar choice stored on the account: "image" for a user-uploaded
    // picture kept as a blob at avatars/<userId>, null for the default
    // initial-letter placeholder. (Built-in presets were removed
    // 2026-11-08; legacy "preset:<id>" values fall back to the default.)
    avatar: text("avatar"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_username_idx").on(t.username)],
);

// Login sessions: the client persists the token and sends it with scoped
// actions; the server resolves it to a user id. Expired rows are rejected.
export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const deals = sqliteTable(
  "deals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    titleZh: text("title_zh"),
    descriptionZh: text("description_zh"),
    instructionsZh: text("instructions_zh"),
    // comma-joined tags: game, ios, dlc, cloud, ai, other
    tags: text("tags").notNull().default("other"),
    platform: text("platform").notNull().default(""),
    source: text("source").notNull().default(""),
    worthCents: integer("worth_cents"),
    imageUrl: text("image_url"),
    // Brand logo URL for cloud/AI entries, resolved server-side from the
    // entry's official-site domain (site's own touch icon / favicon →
    // DuckDuckGo icons → Google favicon service, each verified live).
    // Rendered contain-fit on a themed plate, never cropped like a photo.
    logoUrl: text("logo_url"),
    // JSON array of official store screenshot URLs (Epic GalleryImage / Steam / App Store)
    gallery: text("gallery"),
    // Chinese intro of the game/app itself (gameplay/type/features), from the official store page
    aboutZh: text("about_zh"),
    claimUrl: text("claim_url"),
    // Epic rows only: JSON array of the deal's official offers as captured
    // at sync time — {platform: "pc"|"android"|"ios", namespace, offerId,
    // slug}. The purchase deep links are assembled from these REAL ids
    // (https://store.epicgames.com/purchase?offers=1-<namespace>-<offerId>);
    // null for non-Epic rows and for Epic rows synced before this existed.
    epicOffers: text("epic_offers"),
    // 1 when the official source itself shows the offer is NOT available
    // in the CN storefront (e.g. present in the US mobile discover feed's
    // free-game topic but absent from the CN one). Null = source shows no
    // restriction evidence; never guessed.
    regionLocked: integer("region_locked"),
    // iOS App Store limited-time-free: comma-joined storefront country codes
    // where Apple's official Lookup currently reports price === 0, e.g.
    // "cn,us,jp,in,hk". Empty/null on non-iOS deals or legacy rows (the
    // client treats an empty value as "国区"—the only region the old sync
    // verified). Kept as text so no join table is needed.
    regions: text("regions"),
    instructions: text("instructions"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["active", "upcoming", "expired"] })
      .notNull()
      .default("active"),
    usersCount: integer("users_count"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("deals_external_id_idx").on(t.externalId)],
);

export const marks = sqliteTable(
  "marks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dealId: integer("deal_id").notNull(),
    kind: text("kind", { enum: ["saved", "claimed", "hidden"] }).notNull(),
    // Owner of the mark: a users.id, or 0 for the legacy un-owned pool that
    // existed before in-app accounts (claimed by the first registered user).
    userId: integer("user_id").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("marks_deal_kind_user_idx").on(t.dealId, t.kind, t.userId)],
);

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Platform account bindings (Epic / Steam / GOG), one row per in-app user.
// userId 0 is the legacy un-owned pool (pre-account bindings), claimed by the
// first registered user. Tokens live ONLY in this server-side table; no
// action ever returns them to the client.
export const accounts = sqliteTable(
  "accounts",
  {
  // Owner: a users.id, or 0 for the legacy un-owned pool.
  userId: integer("user_id").notNull().default(0),
  platform: text("platform", { enum: ["epic", "steam", "gog"] }).notNull(),
  displayName: text("display_name"),
  // epic account_id / gog user_id / steamid64
  accountRef: text("account_ref"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  // Steam only: the user's own Web API key, stored server-side, never returned whole.
  steamApiKey: text("steam_api_key"),
  lastSyncAt: integer("last_sync_at"),
  lastSyncNote: text("last_sync_note"),
  updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.platform] })],
);

// Games synced from a bound platform account, plus manually added games.
// Claimed deals are NOT stored here — they are derived from deals + marks.
export const libraryItems = sqliteTable(
  "library_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform", { enum: ["epic", "steam", "gog"] }).notNull(),
    title: text("title").notNull(),
    imageUrl: text("image_url"),
    playtimeMinutes: integer("playtime_minutes"),
    // When playtimeMinutes was last refreshed from the platform (ms epoch).
    // Null = playtime has never been successfully synced for this row.
    playtimeUpdatedAt: integer("playtime_updated_at"),
    // JSON array of platform-side keys the playtime lookup matches on
    // (Epic: the owned records' appName codenames merged into this row).
    playKeys: text("play_keys"),
    // Store-page identifier captured at sync time (Epic catalog product
    // slug / GOG product slug) used to build the official store link.
    // Null = no precise page known; the UI falls back to a store search.
    storeSlug: text("store_slug"),
    // Real game-detail content (intro text, official screenshots, type /
    // developer / publisher / release date) fetched on demand from the
    // platform's official store API the first time the game's detail page
    // is opened, then cached here. detailAt = ms epoch of the last fetch
    // attempt (also set on a miss, so a game with no store page is not
    // refetched on every open — it is retried after a week).
    detailAbout: text("detail_about"),
    detailGallery: text("detail_gallery"),
    detailMeta: text("detail_meta"),
    detailAt: integer("detail_at"),
    // Epic rows only: comma-joined device platforms the Epic catalog
    // evidence supports for this game — "pc" (Windows/Mac releaseInfo),
    // "mobile" (Android/iOS releaseInfo or a -android-/-ios- product
    // slug). Merged across every library record folded into this row, so
    // a game owned on both keeps "pc,mobile". Derived fresh on every
    // sync; when the catalog gives no platform evidence at all the sync
    // stores "pc" (Epic's library is PC-first; the UI mark is a display
    // aid, and mobile verification only trusts an explicit "mobile").
    // Null for Steam/GOG rows and for Epic rows synced before this.
    devicePlatforms: text("device_platforms"),
    // The platform's OWN acquisition timestamp for this game (ms epoch),
    // when the platform reports one. Epic's library records carry an
    // `acquisitionDate` per owned record (verified live 2026-11-08 against
    // a real 1,039-record library: every record had one, spanning
    // 2018→2026) — the earliest date across a game's merged records is
    // stored here and shown as its real 入库时间. Steam's GetOwnedGames
    // and GOG's getFilteredProducts return NO acquisition date, so their
    // rows keep this null and fall back to created_at, which — now that
    // syncs merge incrementally instead of delete+reinsert — is the true
    // FIRST-sync time, labelled 「首次入库（同步）」 in the UI.
    acquiredAt: integer("acquired_at"),
    source: text("source", { enum: ["sync", "manual"] }).notNull().default("sync"),
    extKey: text("ext_key").notNull(),
    // Owner: a users.id, or 0 for the legacy un-owned pool.
    userId: integer("user_id").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("library_items_platform_source_key_user_idx").on(t.platform, t.source, t.extKey, t.userId)],
);

// iOS apps whose App Store price is tracked daily (fixed watchlist + in-feed matches).
export const appWatch = sqliteTable("app_watch", {
  trackId: integer("track_id").primaryKey(),
  name: text("name").notNull(),
  iconUrl: text("icon_url"),
  storeUrl: text("store_url"),
  dealExternalId: text("deal_external_id"),
});

export const appPriceSnapshots = sqliteTable(
  "app_price_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackId: integer("track_id").notNull(),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    snapshotDate: text("snapshot_date").notNull(),
    checkedAt: integer("checked_at").notNull(),
  },
  (t) => [uniqueIndex("app_price_snapshots_track_date_idx").on(t.trackId, t.snapshotDate)],
);
