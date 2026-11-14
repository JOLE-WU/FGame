import { defineAction, z, type ActionsModule, type Ctx } from "./sdk-shim";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import * as schema from "./schema";

// ---------- shared shapes ----------

const dealShape = z.object({
  id: z.number(),
  externalId: z.string(),
  title: z.string(),
  description: z.string(),
  titleZh: z.string().nullable(),
  descriptionZh: z.string().nullable(),
  instructionsZh: z.string().nullable(),
  tags: z.array(z.string()),
  platform: z.string(),
  // games-page bucket derived from the source platform string: epic | steam | gog | prime | other
  gamePlatform: z.enum(["epic", "steam", "gog", "prime", "other"]),
  // APP page eligibility: true only when the deal is verifiably an iOS App
  // Store item (see isAppStoreDeal) — the APP page shows nothing else.
  appStore: z.boolean(),
  // Prime rows only: redemption channel (epic | gog | amazon | legacy | other); null elsewhere
  primeChannel: z.enum(["epic", "gog", "amazon", "legacy", "other"]).nullable(),
  primeChannelLabel: z.string().nullable(),
  source: z.string(),
  worthCents: z.number().nullable(),
  imageUrl: z.string().nullable(),
  // Brand logo for cloud/AI entries (resolved from the official domain);
  // the client renders it contain-fit on a plate, never cropped.
  logoUrl: z.string().nullable(),
  gallery: z.array(z.string()),
  aboutZh: z.string().nullable(),
  claimUrl: z.string().nullable(),
  // Epic rows: the official offers captured at sync (empty elsewhere).
  epicOffers: z.array(
    z.object({
      platform: z.enum(["pc", "android", "ios"]),
      purchaseUrl: z.string(),
      productUrl: z.string(),
    }),
  ),
  // Epic mobile rows (externalId epic-mobile-*): true. The games page
  // files these under their own 「Epic 手游」 area, never merged with the
  // same title's PC row.
  epicMobile: z.boolean(),
  // Which mobile platforms this deal covers (subset of android/ios).
  mobilePlatforms: z.array(z.enum(["android", "ios"])),
  // iOS App Store regions where this limited-time-free app was verified at
  // price 0 (cn/us/jp/in/hk). Empty on non-iOS rows and legacy rows.
  regions: z.array(z.string()),
  // Epic rows with offers on file: ONE purchase deep link carrying every
  // offer (mobile android+iOS combined, PC single) — null elsewhere.
  combinedPurchaseUrl: z.string().nullable(),
  // True only when the official source itself shows a CN restriction.
  regionLocked: z.boolean(),
  instructions: z.string().nullable(),
  publishedAt: z.string().nullable(),
  endAt: z.string().nullable(),
  status: z.string(),
  usersCount: z.number().nullable(),
  saved: z.boolean(),
  claimed: z.boolean(),
  hidden: z.boolean(),
  // Already in this account's game library: either marked claimed here
  // (and fileable under a library group) or verifiably present in the
  // synced rows of the bound platform account under the same title.
  inLibrary: z.boolean(),
  isCustom: z.boolean(),
});

type DealRow = typeof schema.deals.$inferSelect;

type GamePlatform = "epic" | "steam" | "gog" | "prime" | "other";

/** Bucket a deal into the games-page platform filter. Only explicit platform
 *  evidence counts; anything ambiguous stays "other" rather than mislabelled.
 *  "prime" is reserved for the verified Prime Gaming monthly member-games
 *  lineup (externalId prime-*): platform-text mentions of Prime Gaming are
 *  usually in-game loot, not monthly member games, so they must NOT land in
 *  the Prime bucket — they fall through to their store bucket or "other". */
function classifyGamePlatform(row: { externalId: string; platform: string; source: string; title: string }): GamePlatform {
  if (row.externalId.startsWith("prime-")) return "prime";
  // Epic mobile-store rows ARE Epic rows for bucket purposes; the
  // epicMobile flag (from the epic-mobile- prefix) separates them inside
  // the Epic area so they never merge with the PC row of the same title.
  if (row.externalId.startsWith("epic-")) return "epic";
  if (/\bgog(\.com)?\b/i.test(row.platform) || /\(gog\)/i.test(row.title)) return "gog";
  if (/epic games/i.test(row.platform) || /\(epic/i.test(row.title)) return "epic";
  if (/\bsteam\b/i.test(row.platform) || /\(steam\)/i.test(row.title)) return "steam";
  return "other";
}

// ---------- Epic offer ids & purchase deep links ----------
// Epic's own checkout deep link: opening
//   https://store.epicgames.com/purchase?offers=1-<namespace>-<offerId>
// (one `offers` param per offer; android+iOS mobile offers combine into
// a single link) lands a signed-in browser straight on the checkout
// page — placing the $0 order there IS the claim. The ids are captured
// at sync time from Epic's official feeds: for PC rows the
// freeGamesPromotions element's namespace + id; for mobile rows the
// EGS platform-service discover payload's purchasePayload sandboxId +
// offerId. Rows without ids on file fall back to the product page.

type EpicOffer = {
  platform: "pc" | "android" | "ios";
  namespace: string;
  offerId: string;
  slug: string | null;
};

function parseEpicOffers(raw: string | null): EpicOffer[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: EpicOffer[] = [];
    for (const o of v) {
      if (typeof o !== "object" || o === null) continue;
      const r = o as Record<string, unknown>;
      if (
        (r.platform === "pc" || r.platform === "android" || r.platform === "ios") &&
        typeof r.namespace === "string" &&
        r.namespace &&
        typeof r.offerId === "string" &&
        r.offerId
      ) {
        out.push({
          platform: r.platform,
          namespace: r.namespace,
          offerId: r.offerId,
          slug: typeof r.slug === "string" && r.slug ? r.slug : null,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function epicPurchaseUrl(offers: EpicOffer[]): string | null {
  if (offers.length === 0) return null;
  const qs = offers.map((o) => `offers=${encodeURIComponent(`1-${o.namespace}-${o.offerId}`)}`).join("&");
  return `https://store.epicgames.com/purchase?${qs}`;
}

function epicProductUrl(slug: string | null): string | null {
  return slug ? `https://store.epicgames.com/p/${encodeURIComponent(slug)}` : null;
}

/** Epic's own transaction history page — the authoritative place to
 *  confirm a claim landed when library verification cannot see it
 *  (mobile entitlements). Linked verbatim from the claim-queue results. */
const EPIC_TRANSACTIONS_URL = "https://www.epicgames.com/account/transactions?productName=egs";

/**
 * APP-page eligibility: is this deal verifiably an iOS App Store item?
 * Judged ONLY from the deal's own fields (platform / source / claimUrl)
 * plus the iTunes verification the price tracker performs — never from
 * the bare `ios` tag, which GamerPower derives from any "iOS" mention in
 * a multi-platform giveaway's platform list (measured on the live feed:
 * all 10 ios-tagged rows were Android+PC/console key/pack giveaways,
 * none of them App Store items). Rules, in order:
 * 1. Must carry the `ios` tag at all.
 * 2. A claim link straight to apps.apple.com / itunes.apple.com is
 *    definitive proof → in.
 * 3. A user-added row keeps the category its owner picked → in.
 * 4. If the platform field names any non-iOS platform family (Android,
 *    PC, Steam, Epic Games Store, consoles…) the listing is a
 *    store-agnostic multi-platform giveaway → OUT, even when the same
 *    app also exists on the App Store.
 * 5. Otherwise (iOS-only platform text) it is in when the iTunes price
 *    tracker has matched it to a real App Store listing by exact name,
 *    or when the platform text names iOS alone as the only platform.
 */
const NON_IOS_PLATFORM_MARKERS = [
  "android",
  "google play",
  "pc",
  "steam",
  "epic games store",
  "playstation",
  "xbox",
  "nintendo",
  "switch",
  "windows",
  "macos",
  "linux",
];
function isAppStoreDeal(row: DealRow, itunesMatchedDealIds: Set<string>): boolean {
  if (!row.tags.split(",").includes("ios")) return false;
  if (row.claimUrl && /^https?:\/\/(apps|itunes)\.apple\.com\//i.test(row.claimUrl)) return true;
  if (row.externalId.startsWith("custom-")) return true;
  const p = row.platform.toLowerCase();
  if (NON_IOS_PLATFORM_MARKERS.some((m) => p.includes(m))) return false;
  // Verified against a real App Store listing by the iTunes price tracker.
  if (itunesMatchedDealIds.has(row.externalId)) return true;
  // iOS is the only platform named in the field.
  return /\bios\b/.test(p);
}

type PrimeChannel = "epic" | "gog" | "amazon" | "legacy" | "other";

/** Redemption channel of a Prime Gaming member game, from its verified
 *  platform text ("Prime Gaming · GOG 兑换码" etc.). Used by the one-click
 *  claim queue and by the library grouping of claimed Prime games. */
function primeChannelOf(platform: string): PrimeChannel {
  if (/gog/i.test(platform)) return "gog";
  if (/epic/i.test(platform)) return "epic";
  if (/legacy/i.test(platform)) return "legacy";
  if (/amazon/i.test(platform)) return "amazon";
  return "other";
}

const PRIME_CHANNEL_LABEL: Record<PrimeChannel, string> = {
  epic: "Epic",
  gog: "GOG",
  amazon: "Amazon Games App",
  legacy: "Legacy Games",
  other: "Prime 领取页标注渠道",
};

type LibraryGroup = "epic" | "steam" | "gog" | "amazon" | "legacy";

/** The Mine-library group a deal files under — the exact rule listLibrary
 *  applies to claimed deals: Prime member games file under their
 *  redemption channel, other games under their store bucket, and anything
 *  without a determinable group returns null (it cannot be in the library
 *  as a deal entry). */
function libraryGroupOfDeal(row: { externalId: string; platform: string; source: string; title: string }): LibraryGroup | null {
  if (row.externalId.startsWith("prime-")) {
    const ch = primeChannelOf(row.platform);
    return ch === "other" ? null : ch;
  }
  const gp = classifyGamePlatform(row);
  return gp === "epic" || gp === "steam" || gp === "gog" ? gp : null;
}

// ---------- in-app accounts (registration / login / sessions) ----------
// Passwords are hashed with PBKDF2-HMAC-SHA256 (WebCrypto subtle, 210k
// iterations) and a per-user random salt, stored as
// "pbkdf2:<iterations>:<saltHex>:<hashHex>"; plain text is never stored.
// A session is a random 256-bit token in the sessions table, valid 90 days;
// the client persists it and sends it back as `authToken` on scoped actions.
// userId 0 is the legacy un-owned pool (bindings / library / marks created
// before accounts existed). The FIRST user to register adopts the whole pool
// (user_id 0 rows are re-owned), so no existing data is lost; anyone else's
// rows are strictly their own. Unauthenticated calls keep reading/writing
// the pool, which preserves the pre-account behaviour for browsing.

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 512);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PBKDF2_ITERATIONS = 210000;

async function hashPassword(password: string): Promise<string> {
  const saltHex = randomHex(16);
  const hashHex = await pbkdf2Hex(password, hexToBytes(saltHex), PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2" || !parts[1] || !parts[2] || !parts[3]) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 2000000) return false;
  const actualHex = await pbkdf2Hex(password, hexToBytes(parts[2]), iterations);
  const expectedHex = parts[3];
  if (actualHex.length !== expectedHex.length) return false;
  // constant-time comparison over the hex digests
  let diff = 0;
  for (let i = 0; i < actualHex.length; i++) {
    diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

async function issueSession(ctx: Ctx, userId: number): Promise<string> {
  const db = ctx.db<typeof schema>();
  const token = randomHex(32);
  const now = Date.now();
  await db.insert(schema.sessions).values({
    token,
    userId,
    createdAt: now,
    expiresAt: now + 90 * 24 * 3600 * 1000,
  });
  return token;
}

/** Resolve a client session token to a user id; null when absent/expired. */
async function resolveUserId(ctx: Ctx, token: string | undefined | null): Promise<number | null> {
  if (!token) return null;
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token));
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
    return null;
  }
  return row.userId;
}

/** Owner id for scoped reads/writes: the logged-in user, or the legacy pool. */
async function ownerId(ctx: Ctx, token: string | undefined | null): Promise<number> {
  return (await resolveUserId(ctx, token)) ?? 0;
}

const authArg = { authToken: z.string().min(8).max(256).optional() };

// ---------- account avatars ----------
// users.avatar stores the choice on the account itself (never on the
// device): "image" for an uploaded picture whose bytes live in blob
// storage at avatars/<userId>, null for the default initial-letter
// placeholder. (Built-in preset avatars were removed 2026-11-08 at the
// user's request; a legacy "preset:<id>" value now resolves to the
// default placeholder.) getSessionUser resolves it to renderable info,
// so any device logging into the same account sees the same avatar.
const AVATAR_MAX_BYTES = 200 * 1024;

const avatarShape = z
  .object({
    preset: z.string().nullable(),
    imageUrl: z.string().nullable(),
  })
  .nullable();

type AvatarInfo = z.infer<typeof avatarShape>;

async function avatarInfo(ctx: Ctx, user: { id: number; avatar: string | null }): Promise<AvatarInfo> {
  if (!user.avatar) return null;
  if (user.avatar === "image") {
    const url = await ctx.blobs.getUrl(`avatars/${user.id}`);
    return url ? { preset: null, imageUrl: url } : null;
  }
  return null;
}

/** Sniff the real image type from magic bytes; the client's declared type is never trusted. */
function sniffImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

function decodeBase64Image(raw: string): Uint8Array | null {
  const b64 = raw.includes(",") ? (raw.split(",").pop() ?? "") : raw;
  if (!b64 || b64.length > Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024) return null;
  try {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function parseGallery(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((u): u is string => typeof u === "string" && /^https:\/\//i.test(u)).slice(0, 10);
  } catch {
    return [];
  }
}

function toDeal(
  row: DealRow,
  savedIds: Set<number>,
  claimedIds: Set<number>,
  hiddenIds: Set<number> = new Set(),
  itunesMatchedDealIds: Set<string> = new Set(),
  inLibraryIds: Set<number> = new Set(),
) {
  return {
    id: row.id,
    externalId: row.externalId,
    title: row.title,
    description: row.description,
    titleZh: row.titleZh ?? null,
    descriptionZh: row.descriptionZh ?? null,
    instructionsZh: row.instructionsZh ?? null,
    tags: row.tags.split(",").filter(Boolean),
    platform: row.platform,
    gamePlatform: classifyGamePlatform(row),
    appStore: isAppStoreDeal(row, itunesMatchedDealIds),
    primeChannel: row.externalId.startsWith("prime-") ? primeChannelOf(row.platform) : null,
    primeChannelLabel: row.externalId.startsWith("prime-") ? PRIME_CHANNEL_LABEL[primeChannelOf(row.platform)] : null,
    source: row.source,
    worthCents: row.worthCents,
    imageUrl: row.imageUrl,
    logoUrl: row.logoUrl ?? null,
    gallery: parseGallery(row.gallery),
    aboutZh: row.aboutZh ?? null,
    claimUrl: row.claimUrl,
    epicOffers: parseEpicOffers(row.epicOffers).map((o) => ({
      platform: o.platform,
      purchaseUrl: epicPurchaseUrl([o]) ?? "",
      productUrl: epicProductUrl(o.slug) ?? "",
    })),
    epicMobile: row.externalId.startsWith("epic-mobile-"),
    mobilePlatforms: parseEpicOffers(row.epicOffers)
      .map((o) => o.platform)
      .filter((p): p is "android" | "ios" => p === "android" || p === "ios"),
    regions: (row.regions ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    combinedPurchaseUrl: epicPurchaseUrl(parseEpicOffers(row.epicOffers)),
    regionLocked: row.regionLocked === 1,
    instructions: row.instructions,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    endAt: row.endAt ? row.endAt.toISOString() : null,
    status: row.status,
    usersCount: row.usersCount,
    saved: savedIds.has(row.id),
    // 已同步的游戏库里已经存在这款游戏时，自动按「已领」展示：对用户来
    // 说库里有 = 已经拿到了，不必再领一次。只合并显示字段，不写 marks 表，
    // 所以「手动标记已领」仍是用户自己的记录；inLibraryIds 只装 game/dlc，
    // 应用、云服务那些条目不受影响。
    claimed: claimedIds.has(row.id) || inLibraryIds.has(row.id),
    hidden: hiddenIds.has(row.id),
    inLibrary: inLibraryIds.has(row.id),
    isCustom: row.externalId.startsWith("custom-"),
  };
}

// ---------- upstream parsing helpers ----------

function parseWorthCents(worth: unknown): number | null {
  if (typeof worth !== "string") return null;
  const m = worth.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!m || m[1] == null) return null;
  const v = Math.round(parseFloat(m[1]) * 100);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function parseSourceDate(s: unknown): Date | null {
  if (typeof s !== "string" || !s || s === "N/A") return null;
  const d = new Date(s.replace(" ", "T") + (s.includes("T") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
}


// ---------- Chinese translation helpers ----------

function chineseRatio(s: string): number {
  if (!s) return 1;
  const letters = s.replace(/[^A-Za-z\u4e00-\u9fff]/g, "");
  if (!letters) return 1;
  const zh = (letters.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return zh / letters.length;
}

function needsTranslation(s: string | null | undefined): boolean {
  if (!s || !s.trim()) return false;
  if (!/[A-Za-z]{3}/.test(s)) return false;
  return chineseRatio(s) < 0.35;
}

const translationSchema = z.object({
  items: z.array(
    z.object({
      externalId: z.string(),
      titleZh: z.string(),
      descriptionZh: z.string(),
      instructionsZh: z.string().nullable(),
    }),
  ),
});

type Translatable = {
  externalId: string;
  title: string;
  description: string;
  instructions?: string | null;
};

async function translateChunk(
  ctx: Ctx,
  chunk: Translatable[],
): Promise<Map<string, { titleZh: string; descriptionZh: string; instructionsZh: string | null }>> {
  const map = new Map<string, { titleZh: string; descriptionZh: string; instructionsZh: string | null }>();
  if (chunk.length === 0) return map;
  const lines = chunk
    .map(
      (it, i) =>
        `--- 条目 ${i + 1} externalId=${it.externalId}\n标题：${it.title}\n简介：${(it.description ?? "").slice(0, 420)}\n领取步骤：${(it.instructions ?? "").slice(0, 300) || "（无）"}`,
    )
    .join("\n\n");
  const prompt = `把下面这些免费领取条目的标题、简介和领取步骤全部翻译成简体中文，要自然、口语化、准确。\n规则：\n1. 游戏名、软件名、产品专有名词保留英文原名，不要硬译；但 Giveaway 译为“免费领取”，DLC、Bundle、Pack、Key、Loot 等通用词要译成中文（如 DLC= downloadable content 译为“扩展包/道具包”，Giveaway 不要留在中文标题里）。\n2. 标题译文格式示例：英文 "Flotsam (Epic Games) Giveaway" -> "《Flotsam》· Epic 商城免费领取"；英文 "Some Game - DLC Pack Giveaway" -> "《Some Game》扩展包免费领取"。保留平台信息并译成中文（Epic Games Store=Epic 商城，Steam=Steam 平台）。\n3. 简介完整翻译成中文，保留价格、数量、平台、截止等关键信息，链接和网址原样保留。\n4. 领取步骤按原编号逐条翻译成中文，网址原样保留；原步骤为空时返回 null。\n5. 每条都要返回，不要漏掉、不要合并。\n\n${lines}`;
  try {
    const result = await ctx.inference.complete(prompt, { schema: translationSchema });
    for (const item of result.items) {
      if (item.externalId && item.titleZh) {
        map.set(item.externalId, {
          titleZh: item.titleZh.trim(),
          descriptionZh: (item.descriptionZh ?? "").trim(),
          instructionsZh: item.instructionsZh ? item.instructionsZh.trim() : null,
        });
      }
    }
  } catch {
    // Translation is best-effort: keep original English rather than failing the whole sync.
  }
  return map;
}

async function translateItems(ctx: Ctx, items: Translatable[]): Promise<Map<string, { titleZh: string; descriptionZh: string; instructionsZh: string | null }>> {
  const merged = new Map<string, { titleZh: string; descriptionZh: string; instructionsZh: string | null }>();
  const CHUNK = 5;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const part = await translateChunk(ctx, chunk);
    for (const [k, v] of part) merged.set(k, v);
  }
  return merged;
}

function gpTags(type: unknown, platforms: unknown): string[] {
  const tags = new Set<string>();
  const t = typeof type === "string" ? type : "";
  const p = typeof platforms === "string" ? platforms : "";
  if (t === "Game" || t === "Early Access") tags.add("game");
  else if (t === "DLC") tags.add("dlc");
  else tags.add("other");
  if (/\bios\b/i.test(p)) tags.add("ios");
  if (tags.size === 0) tags.add("other");
  return [...tags];
}

type UpsertDeal = {
  externalId: string;
  title: string;
  description: string;
  titleZh?: string | null;
  descriptionZh?: string | null;
  instructionsZh?: string | null;
  tags: string;
  platform: string;
  source: string;
  worthCents: number | null;
  imageUrl: string | null;
  gallery?: string | null;
  claimUrl: string | null;
  instructions: string | null;
  publishedAt: Date | null;
  endAt: Date | null;
  status: "active" | "upcoming";
  usersCount: number | null;
  // Epic rows only (see deals.epic_offers / deals.region_locked).
  epicOffers?: string | null;
  regionLocked?: number | null;
  // iOS 限免：核验为免费的区服（逗号分隔），见 deals.regions。
  regions?: string | null;
};

function parseGpItems(data: unknown): UpsertDeal[] {
  if (!Array.isArray(data)) return [];
  const out: UpsertDeal[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const it = raw as Record<string, unknown>;
    if (it.status !== "Active") continue;
    const id = typeof it.id === "number" ? it.id : null;
    const title = typeof it.title === "string" ? it.title : null;
    if (id == null || !title) continue;
    const endAt = parseSourceDate(it.end_date);
    // Source sometimes keeps long-ended rows flagged Active; don't put dead deals on the wall.
    if (endAt && endAt.getTime() < Date.now()) continue;
    out.push({
      externalId: `gp-${id}`,
      title,
      description: typeof it.description === "string" ? it.description : "",
      tags: gpTags(it.type, it.platforms).join(","),
      platform: typeof it.platforms === "string" ? it.platforms : "",
      source: "GamerPower",
      worthCents: parseWorthCents(it.worth),
      imageUrl:
        typeof it.image === "string" ? it.image : typeof it.thumbnail === "string" ? it.thumbnail : null,
      claimUrl: typeof it.open_giveaway_url === "string" ? it.open_giveaway_url : null,
      instructions: typeof it.instructions === "string" ? it.instructions : null,
      publishedAt: parseSourceDate(it.published_date),
      endAt,
      status: "active",
      usersCount: typeof it.users === "number" ? it.users : null,
    });
  }
  return out;
}

async function fetchGamerPower(): Promise<UpsertDeal[]> {
  const res = await fetch("https://www.gamerpower.com/api/giveaways?sort-by=date", {
    headers: { "User-Agent": "BaiPiaoKongJian/1.0" },
  });
  if (!res.ok) throw new Error(`GamerPower HTTP ${res.status}`);
  return parseGpItems(await res.json());
}

/** Platform-filtered GamerPower feeds (steam / gog / epic-games-store are real
 *  API values; the API has no amazon-prime-gaming value — it answers
 *  "No category found" — so Prime rows are classified from the platform text
 *  of the full feed instead). Used to catch rows a platform filter surfaces
 *  that the date-sorted full feed may have rotated out. */
async function fetchGamerPowerPlatform(param: string): Promise<UpsertDeal[]> {
  try {
    const res = await fetch(`https://www.gamerpower.com/api/giveaways?platform=${param}`, {
      headers: { "User-Agent": "BaiPiaoKongJian/1.0" },
    });
    if (!res.ok) return [];
    return parseGpItems(await res.json());
  } catch {
    return [];
  }
}

type EpicPromo = { startDate?: string; endDate?: string; discountSetting?: { discountPercentage?: number } };

function firstPromo(list: unknown): EpicPromo | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const group = list[0] as Record<string, unknown> | null;
  if (!group || typeof group !== "object") return null;
  const offers = group.promotionalOffers;
  if (!Array.isArray(offers) || offers.length === 0) return null;
  return offers[0] as EpicPromo;
}

async function fetchEpic(): Promise<UpsertDeal[]> {
  const res = await fetch(
    "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US",
    { headers: { "User-Agent": "BaiPiaoKongJian/1.0" } },
  );
  if (!res.ok) throw new Error(`Epic HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const catalog = (data.data as Record<string, unknown> | undefined)?.Catalog as
    | Record<string, unknown>
    | undefined;
  const searchStore = catalog?.searchStore as Record<string, unknown> | undefined;
  const elements = searchStore?.elements;
  if (!Array.isArray(elements)) return [];
  const out: UpsertDeal[] = [];
  for (const raw of elements) {
    if (typeof raw !== "object" || raw === null) continue;
    const el = raw as Record<string, unknown>;
    const title = typeof el.title === "string" ? el.title : null;
    const slug =
      typeof el.productSlug === "string" && el.productSlug
        ? el.productSlug
        : typeof el.id === "string"
          ? el.id
          : null;
    if (!title || !slug) continue;
    const price = el.price as Record<string, unknown> | undefined;
    const total = price?.totalPrice as Record<string, unknown> | undefined;
    const discountPrice = typeof total?.discountPrice === "number" ? total.discountPrice : null;
    const originalPrice = typeof total?.originalPrice === "number" ? total.originalPrice : null;
    const promos = el.promotions as Record<string, unknown> | undefined;
    const current = firstPromo(promos?.promotionalOffers);
    const upcoming = firstPromo(promos?.upcomingPromotionalOffers);
    let status: "active" | "upcoming" | null = null;
    let promo: EpicPromo | null = null;
    if (discountPrice === 0 && current && current.discountSetting?.discountPercentage === 0) {
      status = "active";
      promo = current;
    } else if (
      upcoming &&
      upcoming.discountSetting?.discountPercentage === 0 &&
      upcoming.startDate &&
      new Date(upcoming.startDate).getTime() > Date.now()
    ) {
      status = "upcoming";
      promo = upcoming;
    }
    if (!status || !promo) continue;
    // Offer identity for the purchase deep link: the element's namespace
    // + its own id ARE the offer's namespace + offerId in Epic's catalog
    // (verified against the feed's structure; the assembled link format
    // is Epic's own checkout URL). The product page comes from the
    // element's own offerMappings pageSlug — never a guessed slug.
    const namespace = typeof el.namespace === "string" && el.namespace ? el.namespace : null;
    const offerId = typeof el.id === "string" && el.id ? el.id : null;
    const mappings = el.offerMappings;
    const pageSlug =
      Array.isArray(mappings) &&
      mappings.length > 0 &&
      typeof mappings[0] === "object" &&
      mappings[0] !== null &&
      typeof (mappings[0] as Record<string, unknown>).pageSlug === "string"
        ? ((mappings[0] as Record<string, unknown>).pageSlug as string)
        : null;
    const productSlug = pageSlug ?? (typeof el.productSlug === "string" ? el.productSlug : null);
    const epicOffers: EpicOffer[] =
      namespace && offerId ? [{ platform: "pc", namespace, offerId, slug: productSlug }] : [];
    const images = el.keyImages;
    let imageUrl: string | null = null;
    let gallery: string | null = null;
    if (Array.isArray(images)) {
      const wide = images.find(
        (i) => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === "OfferImageWide",
      ) as Record<string, unknown> | undefined;
      const anyImg = (wide ?? images[0]) as Record<string, unknown> | undefined;
      if (anyImg && typeof anyImg.url === "string") imageUrl = anyImg.url;
      // Official Epic store screenshots: GalleryImage first, featuredMedia as fallback.
      const urlsOf = (type: string) =>
        images
          .filter((i) => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === type)
          .map((i) => (i as Record<string, unknown>).url)
          .filter((u): u is string => typeof u === "string");
      let shots = urlsOf("GalleryImage");
      if (shots.length < 2) shots = [...shots, ...urlsOf("featuredMedia").filter((u) => /\.(jpe?g|png)(\?|$)/i.test(u))];
      shots = [...new Set(shots)].filter((u) => u !== imageUrl).slice(0, 8);
      if (shots.length > 0) gallery = JSON.stringify(shots);
    }
    out.push({
      externalId: `epic-${slug}`,
      title,
      description: typeof el.description === "string" ? el.description : "",
      tags: "game",
      platform: "PC, Epic Games Store",
      source: "Epic 官方",
      worthCents: originalPrice && originalPrice > 0 ? originalPrice : null,
      imageUrl,
      gallery,
      // 去领取 = Epic's own purchase deep link built from the real
      // namespace/offerId above; only when an element somehow carries
      // no ids does it fall back to the product page (refreshDeals no
      // longer overrides this with a GamerPower link — see there).
      claimUrl: epicPurchaseUrl(epicOffers) ?? epicProductUrl(productSlug),
      epicOffers: epicOffers.length > 0 ? JSON.stringify(epicOffers) : null,
      instructions: null,
      publishedAt: promo.startDate ? new Date(promo.startDate) : null,
      endAt: promo.endDate ? new Date(promo.endDate) : null,
      status,
      usersCount: null,
    });
  }
  return out;
}

// ---------- Epic MOBILE store free games ----------
// The mobile storefront runs its OWN weekly free-games program, separate
// from the PC rotation: the offers are distinct catalog items whose
// product slugs carry -android- / -ios- suffixes. Official machine
// source (live-verified 2026-11-08 from the build sandbox): the EGS
// platform service's public discover feed — the same endpoint the
// open-source free-games-claimer uses for mobile discovery:
//   GET https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=<CC>&locale=en&platform=<android|ios>&start=0&store=EGS
// Its topic with type "freeGame" lists the current mobile freebies;
// each offer's content carries the title, mapping.slug, cover media and
// purchase[] entries — the Claim entry (price $0) holds the discount
// (originalPriceDisplay + discountEndDate) and purchasePayload
// {sandboxId, offerId}: the namespace + offerId the purchase deep link
// is assembled from. Caveats measured live: the endpoint sits behind
// Cloudflare and intermittently answers 403 to non-browser user agents
// (a browser UA got 200 on retry) — fetchEpicMobile retries once and a
// failed fetch simply keeps the previous rows (refreshDeals only
// expires epic-mobile rows when a fetch SUCCEEDED). Permanently
// free-to-play titles listed in the topic (e.g. Idle Champions: a $0
// Claim entry with NO discount/original price) are NOT giveaways and
// are skipped, same rule as the PC feed (original price must be > 0).
// Region evidence, also from this source: the SAME feed fetched with
// country=CN omits Chants of Sennaar entirely while listing the other
// titles — a US-listed offer missing from the CN topic is marked
// regionLocked from that official-source difference, never guessed.

type MobileOfferRaw = {
  platform: "android" | "ios";
  title: string;
  slug: string;
  namespace: string;
  offerId: string;
  imageUrl: string | null;
  worthCents: number | null;
  endAt: Date | null;
};

let epicMobileDiag = "";

type MobileDiscoverParsed = {
  // Timed giveaways only (a $0 Claim entry WITH a discount/original
  // price — permanently free-to-play titles riding the topic, e.g. Idle
  // Champions, are excluded, same rule as the PC feed).
  offers: MobileOfferRaw[];
  // EVERY slug listed in the feed's freeGame topic, before the giveaway
  // filter. This is the "在列" (listed) evidence the region comparison
  // uses: a US giveaway whose slug is absent from the CN topic's list is
  // region-locked; one that IS listed in CN is not — regardless of how
  // the CN side prices it.
  topicSlugs: string[];
};

function parseEpicMobileDiscover(data: unknown, platform: "android" | "ios"): MobileDiscoverParsed | null {
  if (typeof data !== "object" || data === null) return null;
  const mods = (data as Record<string, unknown>).data;
  if (!Array.isArray(mods)) return null;
  const offers: MobileOfferRaw[] = [];
  const topicSlugs: string[] = [];
  for (const mod of mods) {
    if (typeof mod !== "object" || mod === null) continue;
    const m = mod as Record<string, unknown>;
    if (m.type !== "freeGame") continue;
    const rawOffers = m.offers;
    if (!Array.isArray(rawOffers)) continue;
    for (const rawOffer of rawOffers) {
      if (typeof rawOffer !== "object" || rawOffer === null) continue;
      const content = (rawOffer as Record<string, unknown>).content as Record<string, unknown> | undefined;
      if (!content) continue;
      const title = typeof content.title === "string" ? content.title : null;
      const mapping = content.mapping as Record<string, unknown> | undefined;
      const slug = typeof mapping?.slug === "string" ? mapping.slug : null;
      if (!title || !slug) continue;
      topicSlugs.push(slug);
      const purchases = content.purchase;
      if (!Array.isArray(purchases)) continue;
      const claim = purchases.find(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          (p as Record<string, unknown>).purchaseType === "Claim" &&
          typeof ((p as Record<string, unknown>).price as Record<string, unknown> | undefined)?.decimalPrice === "number" &&
          (((p as Record<string, unknown>).price as Record<string, unknown>).decimalPrice as number) === 0,
      ) as Record<string, unknown> | undefined;
      if (!claim) continue;
      const discount = claim.discount as Record<string, unknown> | undefined;
      const originalDisplay = typeof discount?.originalPriceDisplay === "string" ? discount.originalPriceDisplay : null;
      const worthCents = originalDisplay ? parseWorthCents(originalDisplay) : null;
      // No discount block / no original price → permanently free
      // title riding the topic, not a timed giveaway.
      if (!worthCents) continue;
      const payload = claim.purchasePayload as Record<string, unknown> | undefined;
      const namespace = typeof payload?.sandboxId === "string" ? payload.sandboxId : null;
      const offerId = typeof payload?.offerId === "string" ? payload.offerId : null;
      if (!namespace || !offerId) continue;
      const endRaw = typeof discount?.discountEndDate === "string" ? discount.discountEndDate : null;
      const endAt = endRaw ? new Date(endRaw) : null;
      if (endAt && Number.isNaN(endAt.getTime())) continue;
      if (endAt && endAt.getTime() < Date.now()) continue;
      const media = content.media as Record<string, unknown> | undefined;
      const card = media?.card16x9 as Record<string, unknown> | undefined;
      const cover = media?.coverImage as Record<string, unknown> | undefined;
      const imageUrl =
        typeof card?.imageSrc === "string" ? card.imageSrc : typeof cover?.imageSrc === "string" ? cover.imageSrc : null;
      offers.push({ platform, title, slug, namespace, offerId, imageUrl, worthCents, endAt });
    }
  }
  return { offers, topicSlugs };
}

/**
 * Cloudflare blocks this endpoint for datacenter IPs (every attempt is 403),
 * while a real browser gets 200. `scripts/epic-discover-snapshot.py` therefore
 * snapshots the same feed through Chromium, and the weekly mobile giveaways —
 * with the namespace/offerId that make the one-tap
 * `store.epicgames.com/purchase?offers=…` checkout possible — keep syncing
 * even when the live call is blocked. Snapshots older than a week are ignored
 * so stale giveaways never resurrect.
 */
function readEpicMobileSnapshot(platform: "android" | "ios", country: string): MobileDiscoverParsed | null {
  const dir = process.env.FGAME_EPIC_SNAPSHOT_DIR ?? join(process.cwd(), "data", "epic-discover");
  const file = join(dir, `${platform}-${country}.json`);
  try {
    const st = statSync(file);
    if (Date.now() - st.mtimeMs > 7 * 24 * 3600 * 1000) return null;
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    const parsed = parseEpicMobileDiscover(data, platform);
    if (parsed) {
      epicMobileDiag = `直连被拦，已用本地快照 ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}`;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function fetchEpicMobileDiscover(platform: "android" | "ios", country: string): Promise<MobileDiscoverParsed | null> {
  const url =
    `https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=${country}&locale=en&platform=${platform}&start=0&store=EGS`;
  // Cloudflare fronts this host and intermittently answers 403 with a
  // __cf_bm bot cookie: replaying that cookie (plus a short backoff)
  // on the next attempt is the measured way through — up to 3 tries.
  let cookie = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 900 * attempt));
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://store.epicgames.com/",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!res.ok) {
        epicMobileDiag = `HTTP ${res.status}`;
        try {
          const setCookies = res.headers.getSetCookie();
          const bm = setCookies.map((c) => c.split(";")[0]).filter((c) => c && c.includes("="));
          if (bm.length > 0) cookie = bm.join("; ");
        } catch {
          // keep the previous cookie
        }
        continue;
      }
      const data: unknown = await res.json();
      return parseEpicMobileDiscover(data, platform);
    } catch (e) {
      epicMobileDiag = e instanceof Error ? e.message : String(e);
      // retry, then the caller keeps the previous rows
    }
  }
  // Every live attempt was blocked — fall back to the browser-made snapshot.
  return readEpicMobileSnapshot(platform, country);
}

function buildEpicMobileDeals(
  android: MobileDiscoverParsed | null,
  ios: MobileDiscoverParsed | null,
  androidCn: MobileDiscoverParsed | null,
  iosCn: MobileDiscoverParsed | null,
): { deals: UpsertDeal[]; ok: boolean } {
  if (android === null && ios === null) return { deals: [], ok: false };
  // Region verdict from the SAME official source: the CN discover
  // topic's listed slugs. A US giveaway absent from that list is locked
  // for CN accounts; one listed there is not. When NEITHER CN fetch
  // answered, the verdict is UNKNOWN (regionLocked null) — never a
  // silently-assumed "not locked": upsertDeals preserves the stored
  // flag for an unknown verdict, and a later sync with a CN answer
  // replaces it with the real one.
  const cnSlugs = new Set([...(androidCn?.topicSlugs ?? []), ...(iosCn?.topicSlugs ?? [])]);
  const cnKnown = androidCn !== null || iosCn !== null;
  // One deal per TITLE: android + iOS are two offers of the same mobile
  // giveaway (the detail page offers per-platform claim buttons plus
  // the combined link). The base slug strips the -android-… / -ios-…
  // suffix segment, so the row's identity is stable across weeks.
  const baseSlugOf = (slug: string): string => slug.replace(/-(android|ios)-[a-z0-9]+$/i, "");
  const byTitle = new Map<string, MobileOfferRaw[]>();
  for (const o of [...(android?.offers ?? []), ...(ios?.offers ?? [])]) {
    const key = o.title.toLowerCase().trim();
    const arr = byTitle.get(key) ?? [];
    arr.push(o);
    byTitle.set(key, arr);
  }
  const deals: UpsertDeal[] = [];
  for (const offers of byTitle.values()) {
    const first = offers[0];
    if (!first) continue;
    const baseSlug = baseSlugOf(first.slug);
    const epicOffers: EpicOffer[] = offers.map((o) => ({
      platform: o.platform,
      namespace: o.namespace,
      offerId: o.offerId,
      slug: o.slug,
    }));
    const plats = offers.map((o) => (o.platform === "android" ? "安卓" : "iOS")).join(" + ");
    const locked = cnKnown && offers.some((o) => !cnSlugs.has(o.slug));
    const endAt = offers.map((o) => o.endAt).find((d): d is Date => d != null) ?? null;
    deals.push({
      externalId: `epic-mobile-${baseSlug}`,
      title: first.title,
      description:
        `Epic 手游商城本周限免（${plats}）：《${first.title}》手游版，独立于 PC 版的移动端商品。在 Epic 官方下单页登录后点「下订单」即可领取，权益进 Epic 账号。` +
        (locked ? "注意：本周该作在 Epic 中国区商城未上架此限免，国区账号可能领不到，需外区账号。" : ""),
      tags: "game",
      platform: `${plats} · Epic 手游商城`,
      source: "Epic 官方",
      worthCents: first.worthCents,
      imageUrl: first.imageUrl,
      claimUrl: epicPurchaseUrl(epicOffers) ?? epicProductUrl(first.slug),
      epicOffers: JSON.stringify(epicOffers),
      // Tri-state on purpose: 1 = CN source proves the lock, 0 = CN
      // source lists it (proven not locked), null = CN source did not
      // answer this run (unknown — upsert preserves the stored flag).
      regionLocked: cnKnown ? (locked ? 1 : 0) : null,
      instructions:
        "1. 点「去领取」打开 Epic 官方下单页（已登录 Epic 账号）\n2. 核对订单金额为 0，点「下订单」完成领取\n3. 领没领到可在 Epic 账户交易页核对（邮件收据可能延迟十几分钟）",
      publishedAt: null,
      endAt,
      status: "active",
      usersCount: null,
      // The row is authored in Chinese already (title pattern + intro),
      // so the sync's translation pass leaves it alone.
      titleZh: `《${first.title}》手游版 · Epic 手游限免`,
      descriptionZh:
        `Epic 手游商城本周限免（${plats}）：《${first.title}》手游版，独立于 PC 版的移动端商品。在 Epic 官方下单页登录后点「下订单」即可领取，权益进 Epic 账号。` +
        (locked ? "注意：本周该作在 Epic 中国区商城未上架此限免，国区账号可能领不到，需外区账号。" : ""),
      instructionsZh:
        "1. 点「去领取」打开 Epic 官方下单页（已登录 Epic 账号）\n2. 核对订单金额为 0，点「下订单」完成领取\n3. 领没领到可在 Epic 账户交易页核对（邮件收据可能延迟十几分钟）",
    });
  }
  // A parsed-but-EMPTY feed is not a successful "no giveaways this week":
  // it means the snapshot is stale (last week's giveaway is already past
  // its discountEndDate, so the parser skipped it) or the topic only lists
  // permanently free titles. Treating it as ok=true used to make
  // storeEpicMobileDeals run expireMissing with an empty set and silently
  // wipe every live epic-mobile row — the whole mobile section vanished.
  // Report "no data" instead: refreshDeals keeps the previous rows and
  // tries the background fetch, saveEpicMobileSnapshot writes nothing.
  if (deals.length === 0) return { deals: [], ok: false };
  return { deals, ok: true };
}

async function fetchEpicMobile(): Promise<{ deals: UpsertDeal[]; ok: boolean }> {
  const [android, ios, androidCn, iosCn] = await Promise.all([
    fetchEpicMobileDiscover("android", "US"),
    fetchEpicMobileDiscover("ios", "US"),
    fetchEpicMobileDiscover("android", "CN"),
    fetchEpicMobileDiscover("ios", "CN"),
  ]);
  return buildEpicMobileDeals(android, ios, androidCn, iosCn);
}

/** Mirror each official mobile row onto its GamerPower duplicate (same
 *  giveaway, e.g. gp "Chants of Sennaar (Mobile) Giveaway"): GP's own
 *  open link for these lands on Epic's /mobile app-download page, not
 *  the checkout — so the duplicate inherits the official row's purchase
 *  deep link, its offer ids (per-platform claim buttons), its
 *  purchase-page instructions (GP's own text describes the old
 *  install-the-app path) and its region-lock flag. Only GP rows that are unambiguously the same
 *  mobile Epic giveaway are touched: exact normalized-title match with
 *  an official mobile deal AND mobile evidence in the row itself
 *  (Android/iOS platform text or a "(Mobile)" title marker). */
async function mirrorEpicMobileOntoGpRows(ctx: Ctx, mobileDeals: UpsertDeal[]): Promise<void> {
  if (mobileDeals.length === 0) return;
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  const norm = (t: string) =>
    t.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s*giveaways?\s*$/i, "").trim();
  for (const m of mobileDeals) {
    const key = norm(m.title);
    if (!key) continue;
    for (const row of rows) {
      if (!row.externalId.startsWith("gp-")) continue;
      if (norm(row.title) !== key) continue;
      if (!/android|ios/i.test(row.platform) && !/\(mobile\)/i.test(row.title)) continue;
      await db
        .update(schema.deals)
        .set({
          claimUrl: m.claimUrl,
          epicOffers: m.epicOffers ?? null,
          // The GP row's own instructions describe the OLD path (open
          // the mobile landing page, install the Epic app) — replace
          // them with the official row's purchase-page steps so the
          // text never contradicts the button above it.
          instructions: m.instructions,
          instructionsZh: m.instructionsZh ?? null,
          ...(m.regionLocked != null ? { regionLocked: m.regionLocked } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.deals.id, row.id));
    }
  }
}

/** The one store path for Epic mobile deals — used by refreshDeals'
 *  direct fetch AND by saveEpicMobileSnapshot (the background-fetch
 *  fallback): upsert the official rows, expire vanished ones under
 *  their own prefix only, then mirror onto GamerPower duplicates. */
async function storeEpicMobileDeals(ctx: Ctx, deals: UpsertDeal[]): Promise<void> {
  // Guard against an empty result ever clearing the section. An empty set
  // here almost always means the Cloudflare-gated feed was unreachable or
  // the browser snapshot is stale, NOT that Epic pulled every giveaway —
  // expireMissing with an empty set would mark all live mobile deals
  // expired. Keep the last good rows until a fetch with real offers lands.
  if (deals.length === 0) return;
  await upsertDeals(ctx, deals);
  await expireMissing(ctx, ["epic-mobile-"], new Set(deals.map((d) => d.externalId)));
  await mirrorEpicMobileOntoGpRows(ctx, deals);
}

/** Re-apply the GP mirroring from the STORED official mobile rows.
 *  refreshDeals upserts GamerPower rows BEFORE the mobile step, and a
 *  background-fetched snapshot can land between two refreshes — either
 *  ordering can leave a GP duplicate holding its own (wrong) link
 *  again. Running this pass near the end of every refresh makes the
 *  mirrored state the deterministic end state. */
async function mirrorStoredEpicMobileDeals(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  const mobile = rows
    .filter((r) => r.externalId.startsWith("epic-mobile-"))
    .map(
      (r): UpsertDeal => ({
        externalId: r.externalId,
        title: r.title,
        description: r.description,
        tags: r.tags,
        platform: r.platform,
        source: r.source,
        worthCents: r.worthCents,
        imageUrl: r.imageUrl,
        claimUrl: r.claimUrl,
        instructions: r.instructions,
        publishedAt: r.publishedAt,
        endAt: r.endAt,
        status: r.status === "upcoming" ? "upcoming" : "active",
        usersCount: r.usersCount,
        epicOffers: r.epicOffers,
        regionLocked: r.regionLocked,
      }),
    );
  await mirrorEpicMobileOntoGpRows(ctx, mobile);
}

// Curated cloud / AI free-tier entries. Cover images (imageUrl) are each
// service's OWN official og:image / brand image, grabbed from the
// official site and verified live on 2026-11-08 (1200×630-class OG
// images; Bailian's is Aliyun's official product brand tile). Services
// whose official pages publish no usable cover image (SiliconFlow has
// no og:image at all; Volcengine exposes only a favicon / 180px logo)
// keep imageUrl null and render the designed brand-gradient cover on
// the client — never a stock photo or a fake screenshot.
const CURATED: UpsertDeal[] = [
  {
    externalId: "curated-ai-siliconflow",
    title: "硅基流动 SiliconFlow · 注册送 ¥14 额度（约 2000 万 Token）",
    description:
      "国内大模型 API 超市，聚合 DeepSeek / Qwen / GLM 等百余款模型，接口兼容 OpenAI。官方计费说明：新用户注册即得 14 元免费额度（约合 2000 万 Qwen1.5-14B Token），另有 BAAI/bge-m3、Hunyuan-MT-7B 等指定小模型在价格页标注长期免费。国内直连、手机号注册即可，额度与免费清单以官网价格页当期为准。",
    tags: "ai",
    platform: "API · 国内直连",
    source: "常驻精选 · 硅基流动官网",
    worthCents: null,
    imageUrl: null,
    claimUrl: "https://www.siliconflow.cn/",
    instructions:
      "1. 打开硅基流动官网，用手机号注册\n2. 控制台「API 密钥」新建 Key\n3. base_url 填 https://api.siliconflow.cn/v1，用 OpenAI SDK 即可调用\n4. 先用价格页标注「免费」的模型跑通，再用赠送额度试付费模型",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-zhipu",
    title: "智谱 GLM Flash 系列 · 永久免费 API（200K 上下文）",
    description:
      "智谱开放平台的 Flash 系列长期 0 元：GLM-4.7-Flash（30B 级、200K 上下文）、GLM-4-Flash-250414、GLM-4V-Flash 视觉、CogView-3-Flash 画图等，官方文档设有专门的「免费模型」板块，不按量计费、仅有并发限制。注意免费的是 4.x 代 Flash，GLM-5.x 旗舰为付费模型。国内手机号注册、直连可用。",
    tags: "ai",
    platform: "API · 国内直连",
    source: "常驻精选 · 智谱开放平台",
    worthCents: null,
    imageUrl: "https://zhipu-ef7018ed.mintlify.site/_mintlify/api/og/v2?division=API+%E6%8C%87%E5%BC%95&title=%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B&theme=ca6d7a77a2bcc842fd1fcef7&signature=7840ffc15209c5c6aa660da21aa0bd790c869c91bb2772c94e8b16735c095703",
    claimUrl: "https://docs.bigmodel.cn/cn/api/introduction",
    instructions:
      "1. 打开智谱开放平台（open.bigmodel.cn）手机号注册\n2. 创建 API Key\n3. 模型名填 glm-4.7-flash 或 glm-4-flash-250414 即为免费档\n4. base_url：https://open.bigmodel.cn/api/paas/v4",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-deepseek",
    title: "DeepSeek 开放平台 · 新用户送 500 万 Token",
    description:
      "DeepSeek 官方 API 新用户赠送 500 万 Token 体验额度（到账起 30 天有效、无需绑卡、自动到账，以控制台券面为准），可用于 DeepSeek-V4 系列；网页端与 App 对话长期免费。接口同时兼容 OpenAI 与 Anthropic 协议，缓存命中价格很低，额度用完后按量计费、无最低消费。",
    tags: "ai",
    platform: "API · 国内直连",
    source: "常驻精选 · DeepSeek 官网",
    worthCents: null,
    imageUrl: "https://cdn.deepseek.com/images/deepseek-chat-open-graph-image.jpeg",
    claimUrl: "https://www.deepseek.com/platform/",
    instructions:
      "1. 打开 DeepSeek 开放平台注册账号，赠送额度自动到账\n2. 「API Keys」创建 Key\n3. base_url：https://api.deepseek.com（OpenAI 格式）\n4. 30 天内用完赠送额度，过期不补发",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-volcengine",
    title: "火山方舟（豆包）· 每模型 50 万 Token 免费推理额度",
    description:
      "字节火山引擎方舟为新用户提供免费推理额度：豆包系列等每个模型各 50 万 Token，免费额度仅抵扣按 Token 后付费的在线推理费用，不同模型分别计算、主账号下共享。另可加入协作奖励计划领额外资源包（以活动页为准）。开启「安心体验模式」后只消耗免费额度、超限即停，不会偷偷扣费。",
    tags: "ai",
    platform: "API · 国内直连",
    source: "常驻精选 · 火山方舟官方文档",
    worthCents: null,
    imageUrl: null,
    claimUrl: "https://ark.volcengine.com/region:cn-beijing/docs/free-inference-quota",
    instructions:
      "1. 注册火山引擎账号并开通方舟\n2. 在「开通管理」查看每个模型的免费额度\n3. 建议打开「安心体验模式」，只用免费额度防扣费\n4. 创建 API Key 后按文档接入点调用",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-bailian",
    title: "阿里云百炼（通义千问）· 新人每模型 100 万 Token",
    description:
      "首次开通阿里云百炼自动发放新人免费额度：主流模型每款各 100 万 Token（输入+输出合计），覆盖 70+ 款模型、总额超 7000 万 Token，各模型额度相互独立。仅限华北 2（北京）地域，自开通起 90 天有效，过期不补发。开通时记得打开「免费额度用完即停」防止转按量扣费。",
    tags: "ai",
    platform: "API · 国内直连",
    source: "常驻精选 · 阿里云百炼官方文档",
    worthCents: null,
    imageUrl: "https://img.alicdn.com/imgextra/i1/O1CN012QgtoH1c1Mu70xD3w_!!6000000003540-2-tps-640-640.png",
    claimUrl: "https://docs.bailian.console.aliyun.com/zh/model-studio/new-free-quota",
    instructions:
      "1. 开通阿里云百炼，选华北 2（北京）地域，额度自动发放\n2. 控制台查看各模型剩余额度（开通后约 2 小时内生效）\n3. 开启「免费额度用完即停」\n4. 创建 API Key，模型名写哪个就扣哪个模型的额度，互不通用",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-groq",
    title: "Groq 免费层 · 每天 20 万 Token / 1000 次请求（极速推理）",
    description:
      "Groq 用自研 LPU 芯片跑开源模型，速度极快。官方 Free Plan 常驻免费、无需绑卡（绑卡是升级 Developer 才需要）：gpt-oss-120b / gpt-oss-20b / Qwen3.8-27B 均为 30 次/分钟、1000 次/天、8000 Token/分钟、20 万 Token/天；另有 Whisper 语音转文字免费额度。限额按组织计、多把 Key 不叠加，准确数字以控制台 Limits 页为准。",
    tags: "ai",
    platform: "API · 海外",
    source: "常驻精选 · Groq 官方文档",
    worthCents: null,
    imageUrl: "https://console.groq.com/og_cloudv5.jpg",
    claimUrl: "https://console.groq.com/docs/rate-limits",
    instructions:
      "1. 打开 console.groq.com 注册并创建 API Key（免费层不用绑卡）\n2. base_url：https://api.groq.com/openai/v1\n3. 模型填 openai/gpt-oss-120b 等免费层模型\n4. 每天 20 万 Token 重置，超限返回 429 等重置即可",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-openrouter",
    title: "OpenRouter 免费模型 · :free 结尾 0 元 / Token",
    description:
      "一个 Key 聚合 400+ 模型。模型 ID 以 :free 结尾的版本按 Token 0 元计费（如 Nemotron 3 Ultra、Gemma 4、Inkling 等，名单轮换频繁），也可以直接用 openrouter/free 路由器自动挑免费模型。官方限额：20 次/分钟；累计充值不足 $10 时 50 次/天，充过 $10 后升到 1000 次/天。注册不用绑卡；注意部分免费供给方可能留存或训练提示词，别发隐私数据。",
    tags: "ai",
    platform: "API · 海外",
    source: "常驻精选 · OpenRouter 官方文档",
    worthCents: null,
    imageUrl: "https://openrouter.ai/dynamic-og?title=API%20Credit%20%26%20Rate%20Limits&description=Handle%20402%20and%20429%20Errors",
    claimUrl: "https://openrouter.ai/docs/api-reference/limits",
    instructions:
      "1. 打开 openrouter.ai 注册（邮箱/GitHub），创建 API Key\n2. base_url：https://openrouter.ai/api/v1\n3. 模型名填带 :free 后缀的 ID，或直接填 openrouter/free\n4. 在模型页搜 free 确认当前免费名单，名单变得快",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-gemini",
    title: "Google Gemini API 免费层 · Flash 系列 Token 免费",
    description:
      "Gemini API 设有 Free Tier：Gemini Flash / Flash-Lite 及 2.5 系列等多款模型的输入与输出 Token 免费，附 Google AI Studio 调试台。具体每分钟/每天限额 Google 不公开固定数字，按项目在 AI Studio 里显示、每天太平洋时间午夜重置。注意：免费层提交的内容会被 Google 用于改进产品并可能被人工审阅，别用免费 Key 传敏感数据；旗舰 Pro Preview 等不在免费层。",
    tags: "ai",
    platform: "API · 海外",
    source: "常驻精选 · Google 官方定价页",
    worthCents: null,
    imageUrl: "https://ai.google.dev/static/site-assets/images/share-ais-513315318.png",
    claimUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    instructions:
      "1. 打开 Google AI Studio（aistudio.google.com）用 Google 账号登录\n2. 创建 API Key\n3. 选 Flash / Flash-Lite 等定价页标注 Free of charge 的模型\n4. 在 AI Studio 的 Rate Limit 页看自己项目的实际限额",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-ai-cloudflare",
    title: "Cloudflare Workers AI · 每天 10000 Neurons 免费",
    description:
      "Cloudflare 每个账号每天免费 10000 Neurons（UTC 00:00 重置），不用绑卡。Neurons 是按算力折算的单位：跑 Llama 3.2 1B 这类小模型约能聊 2000 次短对话，跑 Embedding 约合数百万 Token；大模型消耗快得多。免费额度是全账号共享一池，超限在 Free 计划下直接报错、不会扣费；具体每模型折算率看官方定价页。",
    tags: "ai,cloud",
    platform: "API · 海外",
    source: "常驻精选 · Cloudflare 官方定价文档",
    worthCents: null,
    imageUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/og.png?v=c0f09dd6cf3238d9",
    claimUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    instructions:
      "1. 注册 Cloudflare 免费账号，打开 Workers AI\n2. 创建带 Workers AI 权限的 API Token\n3. 先选小模型试，Neurons 消耗最低\n4. 在控制台看当天 Neurons 用量，UTC 00:00 重置",
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-oracle-free",
    title: "Oracle Cloud Always Free 永久免费套餐",
    description:
      "甲骨文云的常驻免费层：含 ARM / AMD 计算实例、块存储 / 对象存储 / 归档存储、Autonomous 数据库等 Always Free 服务，另有 300 美元试用储值（30 天）。额度与条件以官网为准。",
    tags: "cloud",
    platform: "云服务",
    source: "常驻精选 · Oracle 官网",
    worthCents: null,
    imageUrl: "https://www.oracle.com/a/ocom/img/social-og-oci-logo-1200x628.jpg",
    claimUrl: "https://www.oracle.com/cn/cloud/free/",
    instructions: null,
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
  {
    externalId: "curated-free-hosting",
    title: "免费托管额度对照：Cloudflare / Vercel / Netlify / GitHub Pages",
    description:
      "一份带出处、按各家官方定价与文档核对的免费托管对照（2026 年 9 月底核对）：Cloudflare Pages 静态带宽不限量、Workers 每天 10 万请求；Vercel Hobby 仅限非商业；Netlify 免费版每月 300 credits。具体数字打开对照页看，别凭记忆薅。",
    tags: "cloud",
    platform: "云服务",
    source: "常驻精选 · State of Free Hosting",
    worthCents: null,
    imageUrl: "https://snapdeploy.dev/images/og/pages/state-of-free-hosting.jpg",
    claimUrl: "https://snapdeploy.dev/state-of-free-hosting",
    instructions: null,
    publishedAt: null,
    endAt: null,
    status: "active",
    usersCount: null,
  },
];

// ---------- Prime Gaming monthly member games (verified lineup) ----------
// Inclusion rule (per the user's definition): a Prime Gaming member game
// belongs here while its official claim deadline has NOT passed — regardless
// of the month it launched, since claim windows routinely span months.
// Full games only; in-game loot / skins never qualify.
//
// Verified 2026-11-07 against: Amazon's official "Luna November Content
// Update" (amazongamestudios.com, 2026-11-05) for the November batch (titles,
// launch dates, redemption stores; Amazon publishes NO claim deadlines in the
// announcement), CouchLoot's live-verified claims list (reproduces the end
// date Amazon publishes on each claims page) and Beebom's Prime Gaming list
// for every claim-by date, cross-checked with VGC / Neowin / KitGuru /
// Polygon for the November schedule. Steam regular prices + covers via the
// Steam store API (same channel as the gallery enrichment).
// - Caravan SandWitch deadline: Beebom says Dec 15, CouchLoot (live check
//   2026-11-07) says Dec 16 — the fresher live value is used.
// - The five not-yet-launched November games have no published deadline yet;
//   endAt stays null and the UI shows 截止日待确认 instead of inventing one.
// - Expired 2026-11-04 (DOOM, Five Nights at Freddy's: Into the Pit) are
//   deliberately NOT listed.
// Claim links: claimable games use their per-game luna.amazon.com/claims
// deep link (PRIME_CLAIM_URLS below); not-yet-launched games use the hub
// https://gaming.amazon.com/home (Prime Gaming's official site, now
// Luna-branded; Amazon's own announcement links claims from there).
// There is no machine-readable official feed for the monthly
// lineup — Amazon announces it in monthly blog posts — so this list is
// curated per announcement; the daily sync below re-upserts it and
// auto-expires rows whose deadline has passed or that leave the list.
const PRIME_CLAIM_URL = "https://gaming.amazon.com/home";
/** Per-game claim deep links on Amazon's Luna claims site — resolved verbatim
 *  from the live-verified claims listing (CouchLoot, 2026-11-07; the WRC
 *  Generations UUID is independently confirmed by a HardForum post quoting
 *  the same luna.amazon.com/claims URL). Games not yet launched have no claim
 *  page yet and keep the gaming.amazon.com hub link until they go live. */
const PRIME_CLAIM_URLS: Record<string, string> = {
  "prime-202610-conarium": "https://luna.amazon.com/claims/conarium-gog/dp/amzn1.pg.item.82e258e7-827e-46e0-8228-25e9720b48b4",
  "prime-202610-vampire-swansong": "https://luna.amazon.com/claims/vampire-the-masquerade-swansong-epic/dp/amzn1.pg.item.7885fee3-7dda-40c5-8642-596bb1f4a9b3",
  "prime-202610-ad-infinitum": "https://luna.amazon.com/claims/ad-infinitum-epic/dp/amzn1.pg.item.69de011b-6575-41ab-9964-971e59cf7457",
  "prime-202610-time-travel-escape-room": "https://luna.amazon.com/claims/time-travel-escape-room-game-legacy/dp/amzn1.pg.item.c3af790f-8ce0-42b2-8c16-ebecb97303f5",
  "prime-202610-kiborg": "https://luna.amazon.com/claims/kiborg-aga/dp/amzn1.pg.item.6a6eac09-8806-4c39-95a2-c7cf131f89fc",
  "prime-202610-trash-goblin": "https://luna.amazon.com/claims/trash-goblin-epic/dp/amzn1.pg.item.1892b601-09dc-470b-9d62-7feac63376a3",
  "prime-202611-wrc-generations": "https://luna.amazon.com/claims/wrc-generations-epic/dp/amzn1.pg.item.59a0703f-be28-476e-9160-8e56e257dee5",
  "prime-202611-squirrel-with-a-gun": "https://luna.amazon.com/claims/squirrel-with-a-gun-aga/dp/amzn1.pg.item.70eff815-88f4-47f9-83e0-8a8d2837c7ad",
  "prime-202610-caravan-sandwitch": "https://luna.amazon.com/claims/caravan-sandwitch-aga/dp/amzn1.pg.item.98d2b591-efd2-420f-928c-e7a9b409f67a",
  "prime-202610-warbreeds": "https://luna.amazon.com/claims/warbreeds-gog/dp/amzn1.pg.item.886d058d-6e68-4f53-8e58-3044de3e6bb4",
};
const primeInstructions = (channel: string) =>
  `1. 点下方「去领取」打开这款游戏的官方领取页，登录带有 Prime 会员的亚马逊账号\n2. 点 Claim / Get game 领取\n3. 按页面提示完成兑换，游戏通过${channel}永久入库\n领取需有效的 Amazon Prime 会员资格。`;
const primeCover = (appid: number) =>
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;

const PRIME_GAMES: UpsertDeal[] = [
  {
    externalId: "prime-202610-conarium",
    title: "Conarium",
    titleZh: "《Conarium》· Prime 会员游戏（GOG 兑换码）",
    description:
      "洛夫克拉夫特式第一人称解谜冒险（2017）：扮演 Frank Gilman 在南极 Upuaut 基地醒来，基地空无一人；探索房间、梦境与幻象，收集线索、避开诡异存在，走向多个结局。2026 年 10 月批次上线，领取后通过 GOG 兑换码入库。",
    tags: "game",
    platform: "Prime Gaming · GOG 兑换码",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 1999,
    imageUrl: primeCover(313780),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("GOG 兑换码"),
    publishedAt: new Date(Date.UTC(2026, 9, 8)),
    endAt: new Date(Date.UTC(2026, 10, 11, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-vampire-swansong",
    title: "Vampire: The Masquerade – Swansong",
    titleZh: "《Vampire: The Masquerade – Swansong》· Prime 会员游戏（Epic 兑换）",
    description:
      "叙事 RPG 冒险（2022）：波士顿秘盟陷入动荡，三位百年吸血鬼各怀心事；用威吓、诱惑或潜行推进调查，强化各自的戒律，抉择会改写三人交织的命运。2026 年 10 月批次上线，领取后通过 Epic 兑换入库。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 1999,
    imageUrl: primeCover(1299510),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 9, 15)),
    endAt: new Date(Date.UTC(2026, 10, 18, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-ad-infinitum",
    title: "Ad Infinitum",
    titleZh: "《Ad Infinitum》· Prime 会员游戏（Epic 兑换）",
    description:
      "一战题材冒险恐怖解谜（2023）：在一座荒废的家族庄园与一战壕沟之间切换，躲避梦魇生物、解开环境谜题，揭开一个家庭的战争创伤。2026 年 10 月批次上线，领取后通过 Epic 兑换入库。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 1999,
    imageUrl: primeCover(1234430),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 9, 22)),
    endAt: new Date(Date.UTC(2026, 10, 25, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-time-travel-escape-room",
    title: "Time Travel: Escape Room Game",
    titleZh: "《Time Travel: Escape Room Game》· Prime 会员游戏（Legacy Games 兑换）",
    description:
      "密室逃脱解谜（2024）：穿梭 100 间分布在著名地点与不同时代的密室，找寻隐藏物品、破解逻辑谜题，找回稀有水晶并修好时间机器。2026 年 10 月批次上线，领取后通过 Legacy Games 兑换入库。",
    tags: "game",
    platform: "Prime Gaming · Legacy Games 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 899,
    imageUrl: primeCover(3094600),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Legacy Games"),
    publishedAt: new Date(Date.UTC(2026, 9, 22)),
    endAt: new Date(Date.UTC(2026, 10, 25, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-kiborg",
    title: "Kiborg",
    titleZh: "《Kiborg》· Prime 会员游戏（Amazon Games App）",
    description:
      "动作 Roguelike 格斗（2025）：在未来监狱里为自由而战，近身连招与枪械混搭，靠义体替换、变异与强化改造身体，每局遇到的囚犯都在变化。2026 年 10 月批次上线，领取后通过 Amazon Games App 入库。",
    tags: "game",
    platform: "Prime Gaming · Amazon Games App 入库",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 2499,
    imageUrl: primeCover(2405060),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Amazon Games App"),
    publishedAt: new Date(Date.UTC(2026, 9, 29)),
    endAt: new Date(Date.UTC(2026, 11, 2, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-trash-goblin",
    title: "Trash Goblin",
    titleZh: "《Trash Goblin》· Prime 会员游戏（Epic 兑换）",
    description:
      "温馨开店模拟（2024）：把杂物从土里敲出来，擦洗、拼凑成小饰品，卖给古怪的客人，扩建并装饰你的哥布林小作坊，节奏轻松无压力。2026 年 10 月批次上线，领取后通过 Epic 兑换入库。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 1999,
    imageUrl: primeCover(2407830),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 9, 29)),
    endAt: new Date(Date.UTC(2026, 11, 2, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202611-wrc-generations",
    title: "WRC Generations",
    titleZh: "《WRC Generations》· Prime 会员游戏（Epic 兑换）",
    description:
      "WRC 官方拉力赛车游戏（2022）：驾驶 2022 赛季混动赛车跑遍 165 条计时特殊赛段，管理电池与引擎映射，参加线上联赛，还能自制和分享涂装。2026 年 11 月批次上线，领取后通过 Epic 兑换入库。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 3999,
    imageUrl: primeCover(1953520),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 10, 5)),
    endAt: new Date(Date.UTC(2026, 11, 9, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202611-squirrel-with-a-gun",
    title: "Squirrel with a Gun",
    titleZh: "《Squirrel with a Gun》· Prime 会员游戏（Amazon Games App）",
    description:
      "动作解谜射击沙盒（2024）：扮演持枪松鼠逃出秘密地下设施，用枪械后坐力跨越解谜房间，收集金橡果，对抗特工与 Boss，还能开玩具车逛社区。2026 年 11 月批次上线，领取后通过 Amazon Games App 入库。",
    tags: "game",
    platform: "Prime Gaming · Amazon Games App 入库",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 1999,
    imageUrl: primeCover(2067050),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Amazon Games App"),
    publishedAt: new Date(Date.UTC(2026, 10, 5)),
    endAt: new Date(Date.UTC(2026, 11, 9, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-caravan-sandwitch",
    title: "Caravan SandWitch",
    titleZh: "《Caravan SandWitch》· Prime 会员游戏（Amazon Games App）",
    description:
      "探索冒险（2024）：在末世星球 Cigalo 寻找失踪的姐姐，开小货车或徒步旅行，帮助当地社区，升级工具抵达新的遗迹；没有战斗、没有死亡、没有计时。2026 年 10 月批次上线，领取后通过 Amazon Games App 入库。",
    tags: "game",
    platform: "Prime Gaming · Amazon Games App 入库",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 2499,
    imageUrl: primeCover(1582650),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Amazon Games App"),
    publishedAt: new Date(Date.UTC(2026, 9, 15)),
    endAt: new Date(Date.UTC(2026, 11, 16, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202610-warbreeds",
    title: "WarBreeds",
    titleZh: "《WarBreeds》· Prime 会员游戏（GOG 兑换码）",
    description:
      "经典即时战略（1998）：指挥四个外星部族之一，击败对手并收割其基因材料，用生物武器与自定义攻击阵型，工程出新的战士组合。2026 年 10 月批次上线，领取后通过 GOG 兑换码入库。",
    tags: "game",
    platform: "Prime Gaming · GOG 兑换码",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 10 月）",
    worthCents: 599,
    imageUrl: primeCover(2464660),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("GOG 兑换码"),
    publishedAt: new Date(Date.UTC(2026, 9, 8)),
    endAt: new Date(Date.UTC(2027, 0, 8, 23, 59, 59)),
    status: "active",
    usersCount: null,
  },
  {
    externalId: "prime-202611-jurassic-world-evolution-2",
    title: "Jurassic World Evolution 2",
    titleZh: "《侏罗纪世界：进化 2》Jurassic World Evolution 2 · Prime 会员游戏（Epic 兑换）",
    description:
      "恐龙公园经营模拟（2021），Frontier 出品：建造并经营侏罗纪世界主题公园，繁育 75+ 种恐龙以及飞行、海洋爬行动物。2026 年 11 月 12 日上线，领取后通过 Epic 兑换入库；亚马逊官方尚未公布本款的领取截止日，以领取页显示为准。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 5999,
    imageUrl: primeCover(1244460),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 10, 12)),
    endAt: null,
    status: "upcoming",
    usersCount: null,
  },
  {
    externalId: "prime-202611-radiolight",
    title: "Radiolight",
    titleZh: "《Radiolight》· Prime 会员游戏（Epic 兑换）",
    description:
      "80 年代背景的第一人称惊悚冒险：警察循着无线电信号进入国家公园，追查一名失踪儿童。独立开发者 Krystof Knesl 的作品。2026 年 11 月 12 日上线，领取后通过 Epic 兑换入库；领取截止日待官方公布。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 1499,
    imageUrl: primeCover(1342690),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 10, 12)),
    endAt: null,
    status: "upcoming",
    usersCount: null,
  },
  {
    externalId: "prime-202611-werewolf-earthblood",
    title: "Werewolf: The Apocalypse – Earthblood",
    titleZh: "《Werewolf: The Apocalypse – Earthblood》· Prime 会员游戏（Epic 兑换）",
    description:
      "动作游戏（Cyanide 制作）：被流放的狼人 Cahal 能化身为狼或巨型 Crinos 兽形，为族人与大地而战。2026 年 11 月 19 日上线，领取后通过 Epic 兑换入库；领取截止日待官方公布。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 2999,
    imageUrl: primeCover(679110),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 10, 19)),
    endAt: null,
    status: "upcoming",
    usersCount: null,
  },
  {
    externalId: "prime-202611-clem",
    title: "CLeM",
    titleZh: "《CLeM》· Prime 会员游戏（Epic 兑换）",
    description:
      "黑暗叙事解谜冒险（Mango Protocol 制作）：围绕炼金术展开的诡异故事，在一座神秘宅邸里唤醒、探索并解开层层谜团。2026 年 11 月 19 日上线，领取后通过 Epic 兑换入库；领取截止日待官方公布。",
    tags: "game",
    platform: "Prime Gaming · Epic Games Store 兑换",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 1599,
    imageUrl: primeCover(1861440),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Epic 商城"),
    publishedAt: new Date(Date.UTC(2026, 10, 19)),
    endAt: null,
    status: "upcoming",
    usersCount: null,
  },
  {
    externalId: "prime-202611-arcadia-fallen",
    title: "Arcadia Fallen",
    titleZh: "《Arcadia Fallen》· Prime 会员游戏（Amazon Games App）",
    description:
      "剧情向奇幻 RPG 视觉小说（Galdra Studios 制作）：炼金术学徒与被禁的精灵缔结契约，在魔法与科技交锋的世界里踏上命运之旅。2026 年 11 月 24 日上线，领取后通过 Amazon Games App 入库；领取截止日待官方公布。",
    tags: "game",
    platform: "Prime Gaming · Amazon Games App 入库",
    source: "Prime Gaming · 亚马逊官方阵容（2026 年 11 月）",
    worthCents: 2499,
    imageUrl: primeCover(1174640),
    claimUrl: PRIME_CLAIM_URL,
    instructions: primeInstructions("Amazon Games App"),
    publishedAt: new Date(Date.UTC(2026, 10, 24)),
    endAt: null,
    status: "upcoming",
    usersCount: null,
  },
];

/** Daily Prime lineup check: drop stored prime-* rows that left the verified
 *  lineup, and any whose claim deadline has passed. New-month lineups cannot
 *  be auto-discovered (Amazon announces them in blog posts; there is no
 *  official machine-readable feed), so rotation-in happens by updating
 *  PRIME_GAMES; rotation-out and deadline expiry are fully automatic here. */
async function expirePrimeLineup(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const keep = new Set(PRIME_GAMES.map((g) => g.externalId));
  const now = Date.now();
  const rows = await db
    .select({ id: schema.deals.id, externalId: schema.deals.externalId, endAt: schema.deals.endAt })
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  for (const row of rows) {
    if (!row.externalId.startsWith("prime-")) continue;
    if (!keep.has(row.externalId) || (row.endAt && row.endAt.getTime() < now)) {
      await db.update(schema.deals).set({ status: "expired" }).where(eq(schema.deals.id, row.id));
    }
  }
}

async function upsertDeals(ctx: Ctx, items: UpsertDeal[]): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  for (const item of items) {
    const normalised: UpsertDeal & { titleZh: string | null; descriptionZh: string | null; instructionsZh: string | null; gallery: string | null; epicOffers: string | null; regionLocked: number | null; regions: string | null } = {
      ...item,
      titleZh: item.titleZh ?? null,
      descriptionZh: item.descriptionZh ?? null,
      instructionsZh: item.instructionsZh ?? null,
      gallery: item.gallery ?? null,
      epicOffers: item.epicOffers ?? null,
      regionLocked: item.regionLocked ?? null,
      regions: item.regions ?? null,
    };
    const existing = await db
      .select({ id: schema.deals.id, titleZh: schema.deals.titleZh, descriptionZh: schema.deals.descriptionZh, instructionsZh: schema.deals.instructionsZh, title: schema.deals.title, gallery: schema.deals.gallery, regionLocked: schema.deals.regionLocked, regions: schema.deals.regions })
      .from(schema.deals)
      .where(eq(schema.deals.externalId, item.externalId))
      .limit(1);
    if (existing[0]) {
      // Keep a good earlier translation if this sync could not produce one, or if title unchanged.
      if (!normalised.titleZh && existing[0].titleZh) normalised.titleZh = existing[0].titleZh;
      if (!normalised.descriptionZh && existing[0].descriptionZh) normalised.descriptionZh = existing[0].descriptionZh;
      if (!normalised.instructionsZh && existing[0].instructionsZh) normalised.instructionsZh = existing[0].instructionsZh;
      // A sync that carries no gallery (e.g. GamerPower rows) must not wipe stored screenshots.
      if (!normalised.gallery && existing[0].gallery) normalised.gallery = existing[0].gallery;
      // An UNKNOWN region verdict (null — the CN comparison source did
      // not answer this run) must not erase a stored lock flag; only a
      // CN answer proven this run (0 or 1) replaces it.
      if (normalised.regionLocked == null && existing[0].regionLocked != null) {
        normalised.regionLocked = existing[0].regionLocked;
      }
      // A non-iOS sync (or a source outage) must not wipe a stored region
      // verdict for an existing iOS-free row.
      if (normalised.regions == null && existing[0].regions != null) {
        normalised.regions = existing[0].regions;
      }
      await db
        .update(schema.deals)
        .set({ ...normalised, updatedAt: now })
        .where(eq(schema.deals.id, existing[0].id));
    } else {
      await db.insert(schema.deals).values({ ...normalised, createdAt: now, updatedAt: now });
    }
  }
}

async function backfillTranslations(ctx: Ctx): Promise<number> {
  const db = ctx.db<typeof schema>();
  let totalDone = 0;
  // The model occasionally drops items from a batch; retry the still-missing
  // rows up to 3 passes so a single sync eventually translates everything.
  // Already-Chinese rows (curated entries, user finds) need no model call:
  // their Chinese original IS the translation, so copy it into the zh fields.
  {
    const allRows = await db
      .select()
      .from(schema.deals)
      .where(inArray(schema.deals.status, ["active", "upcoming"]));
    for (const r of allRows) {
      if (r.titleZh) continue;
      if (needsTranslation(`${r.title} ${r.description}`)) continue;
      await db
        .update(schema.deals)
        .set({ titleZh: r.title, descriptionZh: r.description || null, instructionsZh: r.instructions, updatedAt: new Date() })
        .where(eq(schema.deals.id, r.id));
      totalDone++;
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const rows = await db
      .select()
      .from(schema.deals)
      .where(inArray(schema.deals.status, ["active", "upcoming"]));
    const missing = rows
      .filter((r) => !r.titleZh && needsTranslation(`${r.title} ${r.description}`))
      .sort((a, b) => {
        const ea = a.externalId.startsWith("epic-") ? 0 : 1;
        const eb = b.externalId.startsWith("epic-") ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      });
    if (missing.length === 0) break;
    const map = await translateItems(
      ctx,
      missing.map((r) => ({ externalId: r.externalId, title: r.title, description: r.description, instructions: r.instructions })),
    );
    let doneThisPass = 0;
    for (const row of missing) {
      const tr = map.get(row.externalId);
      if (!tr) continue;
      await db
        .update(schema.deals)
        .set({ titleZh: tr.titleZh || null, descriptionZh: tr.descriptionZh || null, instructionsZh: tr.instructionsZh, updatedAt: new Date() })
        .where(eq(schema.deals.id, row.id));
      doneThisPass++;
    }
    totalDone += doneThisPass;
    if (doneThisPass === 0) break;
  }
  return totalDone;
}

async function expireMissing(ctx: Ctx, prefixes: string[], seen: Set<string>): Promise<void> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ id: schema.deals.id, externalId: schema.deals.externalId })
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  for (const row of rows) {
    if (!prefixes.some((p) => row.externalId.startsWith(p))) continue;
    // epic-mobile-* rows expire ONLY under their own prefix: a PC-feed
    // expiry pass must never wipe mobile rows (their source is a
    // separate feed that may have failed this run — see refreshDeals).
    if (row.externalId.startsWith("epic-mobile-") && !prefixes.includes("epic-mobile-")) continue;
    if (!seen.has(row.externalId)) {
      await db.update(schema.deals).set({ status: "expired" }).where(eq(schema.deals.id, row.id));
    }
  }
}

// ---------- official store gallery + intro enrichment ----------
// For game/app deals only: fetch REAL screenshots and a substantive intro from
// the official store that matches the deal (Epic feed keyImages, Steam store
// API, Apple iTunes Search API). Anything not found stays empty — never
// substitute another title's images or generated art.

type GalleryInfo = { images: string[]; about: string | null };

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[《》"“”'‘’™®©:：·・\-–—]/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Chants of Sennaar (Mobile) Giveaway" -> "Chants of Sennaar"; "Dwarven Realms (Steam) Key Giveaway" -> "Dwarven Realms" */
function baseTitle(title: string): string {
  let t = title
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/\s+(giveaways?|steam key|key|beta|playtest)$/i, "").trim();
    if (next === t || next.length < 2) break;
    t = next;
  }
  return t;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchEpicGalleryMap(): Promise<Map<string, GalleryInfo>> {
  const map = new Map<string, GalleryInfo>();
  const res = await fetch(
    "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US",
    { headers: { "User-Agent": "BaiPiaoKongJian/1.0" } },
  );
  if (!res.ok) return map;
  const data = (await res.json()) as Record<string, unknown>;
  const elements = (((data.data as Record<string, unknown> | undefined)?.Catalog as Record<string, unknown> | undefined)
    ?.searchStore as Record<string, unknown> | undefined)?.elements;
  if (!Array.isArray(elements)) return map;
  for (const raw of elements) {
    if (typeof raw !== "object" || raw === null) continue;
    const el = raw as Record<string, unknown>;
    const title = typeof el.title === "string" ? el.title : null;
    if (!title) continue;
    const images = el.keyImages;
    let shots: string[] = [];
    if (Array.isArray(images)) {
      const urlsOf = (type: string) =>
        images
          .filter((i) => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === type)
          .map((i) => (i as Record<string, unknown>).url)
          .filter((u): u is string => typeof u === "string");
      shots = urlsOf("GalleryImage");
      if (shots.length < 2) shots = [...shots, ...urlsOf("featuredMedia").filter((u) => /\.(jpe?g|png)(\?|$)/i.test(u))];
      shots = [...new Set(shots)].slice(0, 8);
    }
    map.set(normName(title), {
      images: shots,
      about: typeof el.description === "string" ? el.description : null,
    });
  }
  return map;
}

async function fetchSteamGallery(name: string): Promise<GalleryInfo | null> {
  const words = name.split(" ");
  const candidates = [
    name,
    name.split(/\s[-–:]\s/)[0] ?? name,
    words.length > 2 ? words.slice(0, -1).join(" ") : "",
    words.length > 3 ? words.slice(0, -2).join(" ") : "",
  ].filter((v, i, a) => v && v.trim().length >= 2 && a.indexOf(v) === i);
  for (const cand of candidates) {
    const sres = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(cand)}&l=en&cc=US`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
    );
    if (!sres.ok) continue;
    const sdata = (await sres.json()) as Record<string, unknown>;
    const items = sdata.items;
    if (!Array.isArray(items) || items.length === 0) continue;
    const want = normName(cand);
    const exact = items.find(
      (i) => typeof i === "object" && i !== null && normName(String((i as Record<string, unknown>).name ?? "")) === want,
    ) as Record<string, unknown> | undefined;
    const first = items[0] as Record<string, unknown>;
    const pick = exact ?? (normName(String(first.name ?? "")).startsWith(want.slice(0, 8)) ? first : undefined);
    if (!pick || typeof pick.id !== "number") continue;
    const ares = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${pick.id}&cc=us&l=schinese`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
    );
    if (!ares.ok) return null;
    const adata = (await ares.json()) as Record<string, unknown>;
    const entry = adata[String(pick.id)] as Record<string, unknown> | undefined;
    const d = entry?.data as Record<string, unknown> | undefined;
    if (!entry?.success || !d) return null;
    const shotsRaw = d.screenshots;
    const images = Array.isArray(shotsRaw)
      ? shotsRaw
          .map((s) => (typeof s === "object" && s !== null ? (s as Record<string, unknown>).path_full : null))
          .filter((u): u is string => typeof u === "string")
          .slice(0, 8)
      : [];
    const genresRaw = d.genres;
    const genres = Array.isArray(genresRaw)
      ? genresRaw
          .map((g) => (typeof g === "object" && g !== null ? (g as Record<string, unknown>).description : null))
          .filter((g): g is string => typeof g === "string")
      : [];
    let about = typeof d.about_the_game === "string" ? stripHtml(d.about_the_game) : "";
    if (about.length < 80 && typeof d.short_description === "string") about = d.short_description.trim();
    if (genres.length > 0 && about) about = `类型：${genres.join(" / ")}\n\n${about}`;
    return { images, about: about ? about.slice(0, 1400) : null };
  }
  return null;
}

async function fetchAppleGallery(name: string): Promise<GalleryInfo | null> {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&country=us&entity=software&limit=8`,
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  const results = data.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const want = normName(name);
  const pick = results.find(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      normName(String((r as Record<string, unknown>).trackName ?? "")) === want,
  ) as Record<string, unknown> | undefined;
  if (!pick) return null;
  const toFull = (u: string) => u.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/0x0ss.jpg");
  const collect = (v: unknown) =>
    Array.isArray(v) ? v.filter((u): u is string => typeof u === "string").map(toFull) : [];
  const images = [...new Set([...collect(pick.screenshotUrls), ...collect(pick.ipadScreenshotUrls)])].slice(0, 8);
  const about = typeof pick.description === "string" ? pick.description.trim().slice(0, 1600) : null;
  return { images, about };
}

const aboutSchema = z.object({
  items: z.array(z.object({ externalId: z.string(), aboutZh: z.string() })),
});

/** Translate official store descriptions into a substantive Chinese intro (gameplay / type / features — not claim steps). */
async function translateAbouts(ctx: Ctx, items: { externalId: string; text: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 3;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const lines = chunk
      .map((it, j) => `--- 条目 ${j + 1} externalId=${it.externalId}\n${it.text.slice(0, 1400)}`)
      .join("\n\n");
    const prompt = `把下面这些游戏/应用在官方商店页的英文介绍翻译整理成简体中文介绍。要求：\n1. 这是介绍游戏/应用本身的内容：玩法、类型、题材、特色系统、剧情背景等实质信息要完整保留并翻成自然中文。\n2. 删掉纯营销口号、获奖名单罗列、系统配置需求、法律声明、版本号更新日志这类非介绍内容。\n3. 游戏名、软件名保留英文原名；控制在 600 字以内，段落之间空一行。\n4. 每条都要返回，不要漏掉、不要合并。\n\n${lines}`;
    try {
      const result = await ctx.inference.complete(prompt, { schema: aboutSchema });
      for (const item of result.items) {
        if (item.externalId && item.aboutZh?.trim()) out.set(item.externalId, item.aboutZh.trim().slice(0, 1200));
      }
    } catch {
      // best-effort: leave aboutZh empty rather than failing the sync
    }
  }
  return out;
}

async function enrichGalleryRows(
  ctx: Ctx,
  opts: { dealId?: number; limit: number },
): Promise<{ updated: number; withImages: number }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  const metaRows = await db.select().from(schema.meta);
  const tried = new Set(
    metaRows.filter((m) => m.key.startsWith("gallery_tried:")).map((m) => m.key.slice("gallery_tried:".length)),
  );
  const eligible = rows
    .filter((r) => {
      const tags = r.tags.split(",");
      if (!tags.includes("game") && !tags.includes("ios")) return false;
      if (opts.dealId != null) return r.id === opts.dealId;
      if (parseGallery(r.gallery).length > 0 && r.aboutZh) return false;
      return !tried.has(r.externalId);
    })
    .sort((a, b) => {
      const ea = a.externalId.startsWith("epic-") ? 0 : 1;
      const eb = b.externalId.startsWith("epic-") ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
    })
    .slice(0, Math.max(1, opts.limit));

  let epicMap: Map<string, GalleryInfo> | null = null;
  let updated = 0;
  let withImages = 0;
  const pendingAbouts: { row: DealRow; info: GalleryInfo }[] = [];

  for (const row of eligible) {
    let info: GalleryInfo | null = null;
    try {
      if (row.externalId.startsWith("epic-")) {
        if (!epicMap) epicMap = await fetchEpicGalleryMap();
        info = epicMap.get(normName(row.title)) ?? null;
        if (info && parseGallery(row.gallery).length === 0 && info.images.length === 0) {
          // Epic element matched by title but carries no screenshots; nothing else to try.
          info = { images: [], about: info.about };
        }
      } else {
        const name = baseTitle(row.title);
        if (/steam/i.test(row.platform)) {
          info = await fetchSteamGallery(name);
        } else if (row.tags.split(",").includes("ios")) {
          info = (await fetchAppleGallery(name)) ?? (await fetchSteamGallery(name));
        } else {
          info = (await fetchSteamGallery(name)) ?? (await fetchAppleGallery(name));
        }
      }
    } catch {
      info = null;
    }

    if (opts.dealId == null) {
      await db
        .insert(schema.meta)
        .values({ key: `gallery_tried:${row.externalId}`, value: new Date().toISOString() })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: new Date().toISOString() } });
    }

    if (!info) continue;
    const images = info.images.filter((u) => u !== row.imageUrl);
    const patch: { gallery?: string; aboutZh?: string } = {};
    if (images.length > 0 && parseGallery(row.gallery).length === 0) {
      patch.gallery = JSON.stringify(images);
      withImages++;
    }
    if (info.about && info.about.trim()) {
      if (row.externalId.startsWith("epic-")) {
        // Epic rows: the giveaway description IS the store description, already translated upstream.
        if (!row.aboutZh && row.descriptionZh) patch.aboutZh = row.descriptionZh;
      } else if (!needsTranslation(info.about)) {
        if (!row.aboutZh) patch.aboutZh = info.about.slice(0, 1200);
      } else if (!row.aboutZh) {
        pendingAbouts.push({ row, info });
      }
    } else if (row.externalId.startsWith("epic-") && !row.aboutZh && row.descriptionZh) {
      patch.aboutZh = row.descriptionZh;
    }
    if (patch.gallery || patch.aboutZh) {
      await db.update(schema.deals).set({ ...patch, updatedAt: new Date() }).where(eq(schema.deals.id, row.id));
      updated++;
    }
  }

  if (pendingAbouts.length > 0) {
    const map = await translateAbouts(
      ctx,
      pendingAbouts.map((p) => ({ externalId: p.row.externalId, text: p.info.about ?? "" })),
    );
    for (const p of pendingAbouts) {
      const zh = map.get(p.row.externalId);
      if (!zh) continue;
      await db
        .update(schema.deals)
        .set({ aboutZh: zh, updatedAt: new Date() })
        .where(eq(schema.deals.id, p.row.id));
      updated++;
    }
  }
  return { updated, withImages };
}

// ---------- library game detail (real store content per owned game) ----------
// The library rows themselves only carry title / cover / playtime. When the
// user opens a game's detail page, the substantive content about the game —
// its official intro, screenshots, genres, developer, publisher, release
// date — is fetched from the platform's own official store API using the
// identifiers captured at sync time, then cached on the library row:
//   Steam — store appdetails by appid (the row's extKey), schinese locale
//   Epic  — store-content product page by product slug (the row's
//           storeSlug), zh-CN first with an en-US fallback (+ translation)
//   GOG   — api.gog.com product record by product id (the row's extKey)
// When a platform source yields nothing, the exact-title Steam search used
// by the deal gallery enrichment is the fallback — same game, real store
// copy, and the response labels which store the content actually came
// from. Nothing found anywhere stays empty; nothing is ever invented.

type LibGameDetail = {
  about: string | null;
  gallery: string[];
  genres: string[];
  developer: string | null;
  publisher: string | null;
  releaseDate: string | null;
  sourceLabel: string;
};

const emptyLibDetail = (sourceLabel: string): LibGameDetail => ({
  about: null,
  gallery: [],
  genres: [],
  developer: null,
  publisher: null,
  releaseDate: null,
  sourceLabel,
});

async function fetchSteamAppDetail(appid: string): Promise<LibGameDetail | null> {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&cc=us&l=schinese`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  const entry = data[appid] as Record<string, unknown> | undefined;
  const d = entry?.data as Record<string, unknown> | undefined;
  if (!entry?.success || !d) return null;
  const shotsRaw = d.screenshots;
  const gallery = Array.isArray(shotsRaw)
    ? shotsRaw
        .map((s) => (typeof s === "object" && s !== null ? (s as Record<string, unknown>).path_full : null))
        .filter((u): u is string => typeof u === "string")
        .slice(0, 8)
    : [];
  const genresRaw = d.genres;
  const genres = Array.isArray(genresRaw)
    ? genresRaw
        .map((g) => (typeof g === "object" && g !== null ? (g as Record<string, unknown>).description : null))
        .filter((g): g is string => typeof g === "string")
        .slice(0, 6)
    : [];
  let about = typeof d.about_the_game === "string" ? stripHtml(d.about_the_game) : "";
  if (about.length < 80 && typeof d.short_description === "string") about = d.short_description.trim();
  const strList = (v: unknown): string | null =>
    Array.isArray(v) ? (v.filter((x): x is string => typeof x === "string").join(" / ") || null) : null;
  const rel = d.release_date as Record<string, unknown> | undefined;
  return {
    about: about ? about.slice(0, 1400) : null,
    gallery,
    genres,
    developer: strList(d.developers),
    publisher: strList(d.publishers),
    releaseDate: typeof rel?.date === "string" && rel.date ? rel.date : null,
    sourceLabel: "Steam 商店",
  };
}

async function fetchEpicProductDetail(slug: string): Promise<LibGameDetail | null> {
  for (const locale of ["zh-CN", "en-US"] as const) {
    try {
      const res = await fetch(
        `https://store-content-ipv4.ak.epicgames.com/api/${locale}/content/products/${encodeURIComponent(slug)}`,
        { headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;
      const pages = Array.isArray(data.pages) ? (data.pages as Record<string, unknown>[]) : [];
      // The product home page carries the game's own about + gallery; offer
      // pages describe bundles/DLC, so prefer the home page, then the page
      // with the longest about text.
      const withAbout = pages
        .map((p) => ({ p, d: (p.data ?? {}) as Record<string, unknown> }))
        .filter(({ d }) => {
          const a = d.about as Record<string, unknown> | undefined;
          return typeof a?.description === "string" && (a.description as string).trim().length > 0;
        })
        .sort((a, b) => {
          const ah = a.p.type === "productHome" ? 0 : 1;
          const bh = b.p.type === "productHome" ? 0 : 1;
          if (ah !== bh) return ah - bh;
          const ad = ((a.d.about as Record<string, unknown>).description as string).length;
          const bd = ((b.d.about as Record<string, unknown>).description as string).length;
          return bd - ad;
        });
      const home = withAbout[0];
      if (!home) continue;
      const aboutObj = home.d.about as Record<string, unknown>;
      const about = stripHtml(String(aboutObj.description ?? "")).slice(0, 1400) || null;
      const galObj = (home.d.gallery ?? {}) as Record<string, unknown>;
      const imgsRaw = Array.isArray(galObj.galleryImages) ? (galObj.galleryImages as Record<string, unknown>[]) : [];
      const gallery = imgsRaw
        .map((i) => (typeof i?.src === "string" ? i.src : null))
        .filter((u): u is string => typeof u === "string" && /\.(jpe?g|png)(\?|$)/i.test(u))
        .slice(0, 8);
      return {
        about,
        gallery,
        genres: [],
        developer: typeof aboutObj.developerAttribution === "string" && aboutObj.developerAttribution ? aboutObj.developerAttribution : null,
        publisher: typeof aboutObj.publisherAttribution === "string" && aboutObj.publisherAttribution ? aboutObj.publisherAttribution : null,
        releaseDate: null,
        sourceLabel: "Epic 商店",
      };
    } catch {
      // try the next locale, then give up
    }
  }
  return null;
}

async function fetchGogProductDetail(productId: string): Promise<LibGameDetail | null> {
  const res = await fetch(`https://api.gog.com/products/${encodeURIComponent(productId)}?expand=description,screenshots`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return null;
  const d = (await res.json()) as Record<string, unknown>;
  if (typeof d.id !== "number" && typeof d.id !== "string") return null;
  const desc = (d.description ?? {}) as Record<string, unknown>;
  const lead = typeof desc.lead === "string" ? stripHtml(desc.lead) : "";
  const full = typeof desc.full === "string" ? stripHtml(desc.full) : "";
  const about = (full.length >= lead.length ? full : lead).slice(0, 1400) || null;
  const shotsRaw = Array.isArray(d.screenshots) ? (d.screenshots as Record<string, unknown>[]) : [];
  const gallery: string[] = [];
  for (const s of shotsRaw) {
    const fmts = Array.isArray(s.formatted_images) ? (s.formatted_images as Record<string, unknown>[]) : [];
    const pick =
      fmts.find((f) => f.formatter_name === "ggvgl_2x") ??
      fmts.find((f) => f.formatter_name === "ggvgl") ??
      fmts.find((f) => f.formatter_name === "ggvgm_2x") ??
      fmts[0];
    if (pick && typeof pick.image_url === "string") gallery.push(pick.image_url);
    if (gallery.length >= 8) break;
  }
  let releaseDate: string | null = null;
  const rd = d.release_date;
  if (typeof rd === "number" && rd > 0) releaseDate = new Date(rd * 1000).toISOString().slice(0, 10);
  else if (typeof rd === "string" && rd) releaseDate = rd.slice(0, 10);
  return { about, gallery, genres: [], developer: null, publisher: null, releaseDate, sourceLabel: "GOG 商店" };
}

// ---------- App Store price watch (real iTunes Lookup snapshots) ----------
// Fixed watchlist of popular paid iOS apps. Every trackId below was verified
// against the live iTunes Lookup API on 2026-11-07 (name + US price returned).
const APP_WATCHLIST: { trackId: number; name: string }[] = [
  { trackId: 479516143, name: "Minecraft" },
  { trackId: 1406710800, name: "Stardew Valley" },
  { trackId: 728293409, name: "Monument Valley" },
  { trackId: 1187265767, name: "Monument Valley 2" },
  { trackId: 916366645, name: "Procreate Pocket" },
  { trackId: 640364616, name: "Terraria" },
  { trackId: 1389752090, name: "Dead Cells" },
  { trackId: 625334537, name: "Geometry Dash" },
  { trackId: 1118115766, name: "Bloons TD 6" },
  { trackId: 763692274, name: "Grand Theft Auto: San Andreas" },
  { trackId: 525818839, name: "Plague Inc." },
];

type ItunesApp = {
  trackId: number;
  trackName: string;
  price: number;
  currency: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
};

async function itunesLookup(ids: number[]): Promise<ItunesApp[]> {
  if (ids.length === 0) return [];
  const res = await fetch(`https://itunes.apple.com/lookup?id=${ids.join(",")}&country=us&entity=software`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Record<string, unknown>;
  const results = data.results;
  if (!Array.isArray(results)) return [];
  const out: ItunesApp[] = [];
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const it = r as Record<string, unknown>;
    if (typeof it.trackId !== "number" || typeof it.price !== "number") continue;
    out.push({
      trackId: it.trackId,
      trackName: typeof it.trackName === "string" ? it.trackName : "",
      price: it.price,
      currency: typeof it.currency === "string" ? it.currency : "USD",
      artworkUrl512: typeof it.artworkUrl512 === "string" ? it.artworkUrl512 : undefined,
      artworkUrl100: typeof it.artworkUrl100 === "string" ? it.artworkUrl100 : undefined,
      trackViewUrl: typeof it.trackViewUrl === "string" ? it.trackViewUrl : undefined,
    });
  }
  return out;
}

/** One snapshot per app per day: seed the watchlist rows, match in-feed iOS
 *  deals to their App Store listing (exact trackName match only), then record
 *  today's price for everything watched. */
async function snapshotAppPrices(ctx: Ctx): Promise<{ tracked: number }> {
  const db = ctx.db<typeof schema>();
  for (const w of APP_WATCHLIST) {
    await db
      .insert(schema.appWatch)
      .values({ trackId: w.trackId, name: w.name })
      .onConflictDoNothing({ target: schema.appWatch.trackId });
  }
  // Match active iOS deals to App Store listings so their prices are tracked too
  // (exact trackName match only, same rule as the screenshot enrichment).
  const dealRows = await db
    .select()
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  const watched = await db.select().from(schema.appWatch);
  const watchedDealIds = new Set(watched.map((w) => w.dealExternalId).filter(Boolean));
  let matched = 0;
  for (const d of dealRows) {
    if (matched >= 6) break;
    // Only App-Store-eligible deals (same field rule as the APP page) may
    // enter the price watch via matching — multi-platform giveaways whose
    // platform field names Android/PC/consoles are not App Store items.
    if (!isAppStoreDeal(d, new Set())) continue;
    if (watchedDealIds.has(d.externalId)) continue;
    try {
      const name = baseTitle(d.title);
      const res = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&country=us&entity=software&limit=8`,
        { headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;
      const results = Array.isArray(data.results) ? data.results : [];
      const want = normName(name);
      const pick = results.find(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          normName(String((r as Record<string, unknown>).trackName ?? "")) === want,
      ) as Record<string, unknown> | undefined;
      if (!pick || typeof pick.trackId !== "number" || typeof pick.trackName !== "string") continue;
      await db
        .insert(schema.appWatch)
        .values({ trackId: pick.trackId, name: pick.trackName, dealExternalId: d.externalId })
        .onConflictDoNothing({ target: schema.appWatch.trackId });
      matched++;
    } catch {
      // best effort per deal
    }
  }
  const watchRows = await db.select().from(schema.appWatch);
  const apps = await itunesLookup(watchRows.map((w) => w.trackId));
  const today = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  let tracked = 0;
  for (const app of apps) {
    const priceCents = Math.round(app.price * 100);
    await db
      .update(schema.appWatch)
      .set({
        name: app.trackName || undefined,
        iconUrl: app.artworkUrl512 ?? app.artworkUrl100 ?? null,
        storeUrl: app.trackViewUrl ?? null,
      })
      .where(eq(schema.appWatch.trackId, app.trackId));
    await db
      .insert(schema.appPriceSnapshots)
      .values({ trackId: app.trackId, priceCents, currency: app.currency, snapshotDate: today, checkedAt: nowMs })
      .onConflictDoNothing({ target: [schema.appPriceSnapshots.trackId, schema.appPriceSnapshots.snapshotDate] });
    tracked++;
  }
  return { tracked };
}

// ---------- iOS App Store 限时免费 (AppRaven 源 + iTunes Lookup 国区核验) ----------
// Source: AppRaven's public GraphQL (the same API its own web app calls,
// https://appraven.net/appraven/graphql). Its appsOnSale feed is a live
// price-change stream; a "gone free" candidate is an app whose CURRENT
// priceTier is 0 and whose last activity is a DROP from a paid tier to 0.
// AppRaven priceTier is an index into Apple's US price-point matrix — the
// table below is the verbatim US matrix AppRaven's own client ships
// (extracted from its web bundle 2026-11-08; tier 62 → $4.99, tier 127 →
// $9.99 spot-checked against live drops). The tier a candidate dropped
// FROM is the source-stated original price; it is labelled as AppRaven's
// US-store figure and is never presented as Apple-verified.
// EVERY candidate is then verified against Apple's official iTunes
// Lookup API with country=cn: only apps the CN storefront returns with
// price === 0 are listed. Name / icon / description / screenshots /
// store link all come from that Lookup response, never from AppRaven.
// A candidate that is paid again in CN, absent from the CN store, or
// missing from Lookup is dropped; the same re-verification runs on
// every sync, and expireMissing takes down rows that no longer verify.
// AppAdvice / iOSnoops were probed first and are unreachable from this
// egress (connection fails); AppSliced now redirects to AppRaven.
const APPLE_US_PRICE_POINTS: number[] = [
  0,0.29,0.39,0.49,0.59,0.69,0.79,0.89,0.9,0.95,0.99,1,1.09,1.19,1.29,1.39,1.49,1.59,1.69,1.79,1.89,1.9,1.95,1.99,2,2.09,2.19,2.29,2.39,2.49,2.59,2.69,2.79,2.89,2.9,2.95,2.99,3,3.09,3.19,3.29,3.39,3.49,3.59,3.69,3.79,3.89,3.9,3.95,3.99,4,4.09,4.19,4.29,4.39,4.49,4.59,4.69,4.79,4.89,4.9,4.95,4.99,5,5.09,5.19,5.29,5.39,5.49,5.59,5.69,5.79,5.89,5.9,5.95,5.99,6,6.09,6.19,6.29,6.39,6.49,6.59,6.69,6.79,6.89,6.9,6.95,6.99,7,7.09,7.19,7.29,7.39,7.49,7.59,7.69,7.79,7.89,7.9,7.95,7.99,8,8.09,8.19,8.29,8.39,8.49,8.59,8.69,8.79,8.89,8.9,8.95,8.99,9,9.09,9.19,9.29,9.39,9.49,9.59,9.69,9.79,9.89,9.9,9.95,9.99,10,10.49,10.9,10.95,10.99,11,11.49,11.9,11.95,11.99,12,12.49,12.9,12.95,12.99,13,13.49,13.9,13.95,13.99,14,14.49,14.9,14.95,14.99,15,15.49,15.9,15.95,15.99,16,16.49,16.9,16.95,16.99,17,17.49,17.9,17.95,17.99,18,18.49,18.9,18.95,18.99,19,19.49,19.9,19.95,19.99,20,20.49,20.9,20.95,20.99,21,21.49,21.9,21.95,21.99,22,22.49,22.9,22.95,22.99,23,23.49,23.9,23.95,23.99,24,24.49,24.9,24.95,24.99,25,25.49,25.9,25.95,25.99,26,26.49,26.9,26.95,26.99,27,27.49,27.9,27.95,27.99,28,28.49,28.9,28.95,28.99,29,29.49,29.9,29.95,29.99,30,30.49,30.9,30.95,30.99,31,31.49,31.9,31.95,31.99,32,32.49,32.9,32.95,32.99,33,33.49,33.9,33.95,33.99,34,34.49,34.9,34.95,34.99,35,35.49,35.9,35.95,35.99,36,36.49,36.9,36.95,36.99,37,37.49,37.9,37.95,37.99,38,38.49,38.9,38.95,38.99,39,39.49,39.9,39.95,39.99,40,40.49,40.9,40.95,40.99,41,41.49,41.9,41.95,41.99,42,42.49,42.9,42.95,42.99,43,43.49,43.9,43.95,43.99,44,44.49,44.9,44.95,44.99,45,45.49,45.9,45.95,45.99,46,46.49,46.9,46.95,46.99,47,47.49,47.9,47.95,47.99,48,48.49,48.9,48.95,48.99,49,49.49,49.9,49.95,49.99,50,50.9,50.99,51,51.9,51.99,52,52.9,52.99,53,53.9,53.99,54,54.9,54.99,55,55.9,55.99,56,56.9,56.99,57,57.9,57.99,58,58.9,58.99,59,59.9,59.99,60,60.9,60.99,61,61.9,61.99,62,62.9,62.99,63,63.9,63.99,64,64.9,64.99,65,65.9,65.99,66,66.9,66.99,67,67.9,67.99,68,68.9,68.99,69,69.9,69.99,70,70.9,70.99,71,71.9,71.99,72,72.9,72.99,73,73.9,73.99,74,74.9,74.99,75,75.9,75.99,76,76.9,76.99,77,77.9,77.99,78,78.9,78.99,79,79.9,79.99,80,80.9,80.99,81,81.9,81.99,82,82.9,82.99,83,83.9,83.99,84,84.9,84.99,85,85.9,85.99,86,86.9,86.99,87,87.9,87.99,88,88.9,88.99,89,89.9,89.99,90,90.9,90.99,91,91.9,91.99,92,92.9,92.99,93,93.9,93.99,94,94.9,94.99,95,95.9,95.99,96,96.9,96.99,97,97.9,97.99,98,98.9,98.99,99,99.9,99.99,100,100.99,101.99,102.99,103.99,104.99,105.99,106.99,107.99,108.99,109,109.99,110.99,111.99,112.99,113.99,114.99,115.99,116.99,117.99,118.99,119,119.99,120.99,121.99,122.99,123.99,124.99,125.99,126.99,127.99,128.99,129,129.99,130.99,131.99,132.99,133.99,134.99,135.99,136.99,137.99,138.99,139,139.99,140.99,141.99,142.99,143.99,144.99,145.99,146.99,147.99,148.99,149,149.99,150,150.99,151.99,152.99,153.99,154.99,155.99,156.99,157.99,158.99,159,159.99,160.99,161.99,162.99,163.99,164.99,165.99,166.99,167.99,168.99,169,169.99,170.99,171.99,172.99,173.99,174.99,175.99,176.99,177.99,178.99,179,179.99,180.99,181.99,182.99,183.99,184.99,185.99,186.99,187.99,188.99,189,189.99,190,190.99,191.99,192.99,193.99,194.99,195.99,196.99,197.99,198.99,199,199.99,200,204.99,209,209.99,214.99,219,219.99,224.99,229,229.99,234.99,239,239.99,244.99,249,249.99,250,254.99,259,259.99,264.99,269,269.99,274.99,279,279.99,284.99,289,289.99,290,294.99,299,299.99,300,304.99,309,309.99,314.99,319,319.99,324.99,329,329.99,334.99,339,339.99,344.99,349,349.99,350,354.99,359,359.99,364.99,369,369.99,374.99,379,379.99,384.99,389,389.99,390,394.99,399,399.99,400,449.99,499.99,599.99,699.99,799.99,899.99,999.99,
];

type IosFreeCandidate = {
  trackId: number;
  /** Source-stated original (pre-drop) US price in cents, from the tier
   *  the app dropped from; null when the tier is outside the matrix. */
  wasCents: number | null;
  droppedAt: Date | null;
};

async function fetchAppRavenFreeCandidates(): Promise<IosFreeCandidate[]> {
  const query =
    "query { appsOnSale(rareOnly: false, miniFilter: {ratingCount: 0}, page: PAGE, pageSize: 20) { hasNext content { app { ITunesId priceTier lastActivity { timestamp ... on AppActivityPriceChange { priceChangeType: type priceTierFrom priceTierTo } } } } } }";
  const byId = new Map<number, IosFreeCandidate>();
  // The feed is a live activity stream (server caps pageSize at 20);
  // 12 pages ≈ the last ~2 days of price changes — ample for a daily list.
  for (let page = 0; page < 12; page++) {
    const res = await fetch("https://appraven.net/appraven/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ query: query.replace("PAGE", String(page)) }),
    });
    if (!res.ok) throw new Error(`AppRaven HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const sale = (data.data as Record<string, unknown> | undefined)?.appsOnSale as
      | Record<string, unknown>
      | undefined;
    const content = sale?.content;
    if (!Array.isArray(content)) throw new Error("AppRaven 返回结构异常");
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const app = (item as Record<string, unknown>).app as Record<string, unknown> | undefined;
      if (!app || typeof app.ITunesId !== "number" || app.priceTier !== 0) continue;
      const la = (app.lastActivity ?? {}) as Record<string, unknown>;
      if (la.priceChangeType !== "DROP" || la.priceTierTo !== 0) continue;
      const from = typeof la.priceTierFrom === "number" ? la.priceTierFrom : 0;
      if (from <= 0 || byId.has(app.ITunesId)) continue;
      const was = APPLE_US_PRICE_POINTS[from];
      const ts = typeof la.timestamp === "string" ? new Date(la.timestamp) : null;
      byId.set(app.ITunesId, {
        trackId: app.ITunesId,
        wasCents: was != null ? Math.round(was * 100) : null,
        droppedAt: ts && !Number.isNaN(ts.getTime()) ? ts : null,
      });
    }
    if (sale?.hasNext !== true) break;
  }
  return [...byId.values()];
}

// App Store 区服：iOS 限免按区推荐。每条候选都用 Apple 官方 iTunes
// Lookup 在对应国家分别核验「当前价格 === 0」，只把真正在该区免费的
// 区服写进 deals.regions；绝不用猜测或跨区推断。
const IOS_REGIONS = [
  { code: "cn", cc: "cn", label: "国区" },
  { code: "us", cc: "us", label: "美区" },
  { code: "jp", cc: "jp", label: "日区" },
  { code: "in", cc: "in", label: "印度区" },
  { code: "hk", cc: "hk", label: "港区" },
] as const;

type IosFreeLookupApp = {
  trackId: number;
  trackName: string;
  price: number;
  description: string;
  artworkUrl512?: string;
  screenshotUrls: string[];
  trackViewUrl?: string;
};

/** 本体限免的领取说明。内购检测会把「内购当前 0 元」追加到这段文案
 *  后面，内购恢复收费时又要把这一段原样写回去 —— 所以文案统一从这里
 *  生成，两处不各写一份。 */
function iosFreeInstructions(codes: string[]): string {
  const labels = codes
    .map((code) => IOS_REGIONS.find((r) => r.code === code)?.label ?? code)
    .join(" / ");
  return (
    `已在 Apple 官方核验为免费的区服：${labels}。\n` +
    `切换到对应区服的 App Store 账号，打开应用页确认价格显示「免费」后点「获取」即永久入库。\n` +
    `限时免费，恢复收费即下架；原价为 AppRaven 标注的美区价，现价已逐区用 App Store 官方接口核验。`
  );
}

/** Bulk iTunes Lookup against ONE storefront. `country` is the App Store
 *  country code (cn/us/jp/in/hk). Returns only items that store sells. */
async function itunesLookupByRegion(ids: number[], country: string): Promise<IosFreeLookupApp[]> {
  const out: IosFreeLookupApp[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const res = await fetch(
        `https://itunes.apple.com/lookup?id=${chunk.join(",")}&country=${country}&entity=software`,
        { headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;
      const results = Array.isArray(data.results) ? data.results : [];
      for (const r of results) {
        if (typeof r !== "object" || r === null) continue;
        const it = r as Record<string, unknown>;
        if (typeof it.trackId !== "number" || typeof it.price !== "number") continue;
        const shots = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        const upgrade = (u: string) => u.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/0x0ss.jpg");
        out.push({
          trackId: it.trackId,
          trackName: typeof it.trackName === "string" ? it.trackName : "",
          price: it.price,
          description: typeof it.description === "string" ? it.description : "",
          artworkUrl512: typeof it.artworkUrl512 === "string" ? it.artworkUrl512 : undefined,
          screenshotUrls: [...shots(it.screenshotUrls), ...shots(it.ipadScreenshotUrls)].map(upgrade),
          trackViewUrl: typeof it.trackViewUrl === "string" ? it.trackViewUrl : undefined,
        });
      }
    } catch {
      // a single storefront outage must not abort the other regions
    }
  }
  return out;
}

/** One multi-region iOS-free sync pass. Returns null when the SOURCE fetch
 *  failed — the caller keeps the previously listed rows untouched (a source
 *  outage must not empty the shelf). Each candidate is verified free in each
 *  of the five storefronts; only regions where Apple reports price 0 are
 *  stored in deals.regions. */
async function syncIosFreeApps(ctx: Ctx): Promise<{ listed: number; checked: number } | null> {
  let candidates: IosFreeCandidate[];
  try {
    candidates = await fetchAppRavenFreeCandidates();
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;

  const ids = candidates.map((c) => c.trackId);
  // One bulk Lookup per storefront; failures degrade to "no data for this
  // region" rather than losing the whole sync.
  const perRegion = new Map<string, Map<number, IosFreeLookupApp>>();
  await Promise.all(
    IOS_REGIONS.map(async (r) => {
      const list = await itunesLookupByRegion(ids, r.cc);
      perRegion.set(r.code, new Map(list.map((v) => [v.trackId, v])));
    }),
  );

  const items: UpsertDeal[] = [];
  for (const c of candidates) {
    const codes: string[] = [];
    let info: IosFreeLookupApp | null = null;
    for (const r of IOS_REGIONS) {
      const v = perRegion.get(r.code)?.get(c.trackId);
      // The gate: this storefront sells it AND its current price here is 0.
      if (v && v.price === 0 && v.trackName) {
        codes.push(r.code);
        // Prefer the CN listing for canonical name/art/description.
        if (!info || r.code === "cn") info = v;
      }
    }
    if (codes.length === 0 || !info) continue;

    // Region-appropriate App Store link (CN when free there, else the first
    // verified region). The client swaps the country segment per selection.
    const primaryCc = codes.includes("cn")
      ? "cn"
      : (IOS_REGIONS.find((r) => r.code === codes[0])?.cc ?? "us");
    const storeUrl =
      info.trackViewUrl && codes.includes("cn")
        ? info.trackViewUrl
        : `https://apps.apple.com/${primaryCc}/app/id${c.trackId}`;
    const labels = codes
      .map((code) => IOS_REGIONS.find((r) => r.code === code)?.label ?? code)
      .join(" / ");

    items.push({
      externalId: `iosfree-${c.trackId}`,
      title: info.trackName,
      description: info.description,
      titleZh: info.trackName,
      descriptionZh: info.description || null,
      instructionsZh: iosFreeInstructions(codes),
      tags: "ios",
      platform: "iOS · App Store",
      source: `AppRaven（App Store 多区核验：${labels}）`,
      worthCents: c.wasCents,
      imageUrl: info.artworkUrl512 ?? null,
      gallery: info.screenshotUrls.length > 0 ? JSON.stringify(info.screenshotUrls.slice(0, 10)) : null,
      claimUrl: storeUrl,
      instructions: null,
      publishedAt: c.droppedAt ?? new Date(),
      endAt: null,
      status: "active",
      usersCount: null,
      regions: codes.join(","),
    });
    if (items.length >= 50) break;
  }
  // A source that returned candidates but verified NONE as free (e.g. all
  // five Lookups were blocked) is treated as an outage, not an empty shelf.
  if (items.length === 0) return null;
  await upsertDeals(ctx, items);
  await expireMissing(ctx, ["iosfree-"], new Set(items.map((i) => i.externalId)));
  return { listed: items.length, checked: candidates.length };
}

// ---------- iOS 内购限免（发现 + 官方核验两层） ----------
// 内购（IAP）价格没有任何批量 API：iTunes Lookup 只回答 App 本体价格。
// 所以分成两层：
//
//  1) 发现层 —— AppRaven 的 GraphQL（appraven.net/appraven/graphql）。
//     `appByITunesId(iTunesId:)` 一次就返回这个 App 的全部内购及其
//     priceTier（0 = 免费，其余是美区价格档位索引），一次请求不到 1KB，
//     可以按千级规模扫。实测：Shredly「Shredly Pro Lifetime」、
//     AudioM「AudioM Pro Lifetime」、I'm Bored「Lifetime Premium」这些
//     当时确实 0 元的内购，AppRaven 都如实标 tier 0。
//
//  2) 核验层 —— Apple 自己的 App Store 应用页。页面是服务端渲染的，
//     内嵌 JSON 里有一段 `Annotation`「App内购买」→ items[]，每项
//     leadingText 是内购名、trailingText 是它此刻的价格文本（`¥0.00` /
//     `¥198.00` / `免费`）。只有 Apple 页面也标 0 的才算数 —— AppRaven
//     的档位会滞后，"内购限免"这种要花钱的判断不能只听第三方。
//     实测（2026-11-09）：Shredly「终身会员 ¥0.00」、AudioM「AudioM Pro
//     永久版 ¥0.00」、维刻「维刻 Pro 终身版（早鸟价）¥0.00」。
//
// 「限时」的判定靠我们自己的价格历史（data/iap-price-history.json）：
// 每个内购记最后一次收费档位 paidTier 和第一次看到 0 元的时间。曾经
// 收费、现在 0 元 → 标「内购限免」并给出原价；从来没见它收过费 → 只能
// 标「内购 0 元」，并且连续 10 天都是 0 就下架（长期免费的权益项不是
// 限免情报，不该一直占着列表）。
//
// 与本体限免的区分（客户端按 tags/platform 渲染标签）：
//   · iosfree-*  tags = "ios"      → 「本体限免」
//   · iosiap-*   tags = "ios,iap"  → 「内购限免」/「内购 0 元」
//   · 同一个 App 两样都中 → 不建新行，直接把已有 iosfree-* 行的 tags
//     升成 "ios,iap"，避免一级页面出现两条同名卡片；内购恢复收费时
//     自动降级回纯本体限免。
const IAP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type IapPriceItem = { name: string; priceText: string; cents: number | null };

/** 价格文本 → 分。「¥0.00」「$9.99」「HK$ 1,298.00」「免费」「Free」。
 *  不是价格（空串、纯链接行）返回 null。 */
function iapPriceCents(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(免费|免費|free|gratis|無料|kostenlos)$/i.test(t)) return 0;
  const digits = t.replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (!/\d/.test(digits)) return null;
  const v = Number.parseFloat(digits);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/** 从应用页 HTML 里取出内购清单。返回 [] 表示这个页面没有内购区块
 *  （App 当前没有可见内购），不是抓取失败 —— 抓取失败由调用方用异常
 *  区分，两者不能混。 */
function parseAppStoreIap(html: string): IapPriceItem[] {
  const head = /"\$kind":"Annotation","title":"[^"]*(?:内购买|內購買|In-App Purchases?)[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(html)) !== null) {
    const itemsAt = html.indexOf('"items":[', m.index + m[0].length);
    if (itemsAt < 0) continue;
    const open = html.indexOf("[", itemsAt);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < html.length; i++) {
      const c = html[i];
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth !== 0) continue;
        let arr: unknown;
        try {
          arr = JSON.parse(html.slice(open, i + 1));
        } catch {
          return [];
        }
        if (!Array.isArray(arr)) return [];
        const out: IapPriceItem[] = [];
        for (const raw of arr) {
          if (typeof raw !== "object" || raw === null) continue;
          const it = raw as Record<string, unknown>;
          const name = typeof it.leadingText === "string" ? it.leadingText.trim() : "";
          const priceText = typeof it.trailingText === "string" ? it.trailingText.trim() : "";
          if (!name) continue;
          out.push({ name, priceText, cents: iapPriceCents(priceText) });
        }
        return out;
      }
    }
  }
  return [];
}

async function fetchAppStoreIap(trackId: number, cc = "cn"): Promise<IapPriceItem[]> {
  const res = await fetch(`https://apps.apple.com/${cc}/app/id${trackId}`, {
    headers: { "User-Agent": IAP_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`App Store HTTP ${res.status}`);
  return parseAppStoreIap(await res.text());
}

async function appRavenGql(query: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://appraven.net/appraven/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`AppRaven HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown> | undefined;
    throw new Error(`AppRaven: ${typeof first?.message === "string" ? first.message : "查询失败"}`);
  }
  const data = body.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/** 扫描池：AppRaven 里「有内购」的 App，用五种排序各翻 20 页拼起来
 *  （单排序深翻到第 30 页就没数据了）。约 2200 个 App、13 秒，缓存 12
 *  小时 —— 池子本身一天建一次就够，每天真正跑的是逐 App 的内购查询。 */
type IapPoolEntry = { title: string; priceTier: number | null; iapCount: number };

function iapDataPath(file: string): string {
  return join(process.env.FGAME_DATA_DIR ?? join(process.cwd(), "data"), file);
}

async function buildIapPool(): Promise<Record<string, IapPoolEntry>> {
  try {
    const cached = JSON.parse(readFileSync(iapDataPath("iap-pool.json"), "utf8")) as {
      builtAt?: string;
      apps?: Record<string, IapPoolEntry>;
    };
    const builtAt = cached?.builtAt ? new Date(cached.builtAt).getTime() : 0;
    if (cached?.apps && Object.keys(cached.apps).length > 200 && Date.now() - builtAt < 12 * 3600_000) {
      return cached.apps;
    }
  } catch {
    // 没有缓存就重建
  }

  const sorts: [string, string][] = [
    ["RATING_COUNT", "DESCENDING"],
    ["SCORE", "DESCENDING"],
    ["RELEASE_DATE", "DESCENDING"],
    ["PRICE", "ASCENDING"],
    ["RATING", "DESCENDING"],
  ];
  const apps: Record<string, IapPoolEntry> = {};
  const tasks = sorts.flatMap(([by, dir]) => Array.from({ length: 20 }, (_, p) => ({ by, dir, p })));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        if (!task) break;
        try {
          const data = await appRavenGql(
            `query { filterApps(appFilter: {hasInAppPurchases: true}, appSort: {by: ${task.by}, direction: ${task.dir}}, page: ${task.p}) { content { ITunesId title priceTier iapCount } } }`,
          );
          const list = data.filterApps as Record<string, unknown> | undefined;
          const content = list?.content;
          if (!Array.isArray(content) || content.length === 0) continue;
          for (const raw of content) {
            if (typeof raw !== "object" || raw === null) continue;
            const it = raw as Record<string, unknown>;
            if (typeof it.ITunesId !== "number") continue;
            apps[String(it.ITunesId)] = {
              title: typeof it.title === "string" ? it.title : "",
              priceTier: typeof it.priceTier === "number" ? it.priceTier : null,
              iapCount: typeof it.iapCount === "number" ? it.iapCount : 0,
            };
          }
        } catch {
          // 单个分页失败不毁整池
        }
      }
    }),
  );

  // 补充源：AppRaven 动态流 + Apple 各区 top-free 榜单。它们没有内购
  // 档位信息（priceTier 未知），只作为「多扫几个 App」的名额，真正的
  // 判断还是靠随后的 appByITunesId 与 Apple 页面。
  const extras: number[] = [];
  try {
    for (const field of ["appsOnSale", "newApps", "updatedApps"] as const) {
      extras.push(...(await fetchActivityIds(field, field === "appsOnSale" ? 8 : 5)));
    }
  } catch {
    // 动态流失败不影响排序池
  }
  const rssIds: number[] = [];
  await Promise.all(
    ["cn", "us", "jp", "hk", "in"].map(async (cc) => {
      rssIds.push(...(await fetchTopFreeIds(cc, 100)));
    }),
  );
  extras.push(...rssIds);
  for (const id of extras) {
    const key = String(id);
    if (apps[key]) continue;
    apps[key] = { title: "", priceTier: null, iapCount: 0 };
  }

  if (Object.keys(apps).length > 0) {
    try {
      writeFileSync(
        iapDataPath("iap-pool.json"),
        JSON.stringify({ builtAt: new Date().toISOString(), apps }),
        "utf8",
      );
    } catch {
      // 缓存写不进去只影响下次启动速度
    }
  }
  return apps;
}

type IapAppLookup = {
  trackId: number;
  title: string;
  bodyTier: number | null;
  iaps: { name: string; tier: number }[];
};

/** 一次请求拿到一个 App 的全部内购档位。App 不在 AppRaven 里返回 null。 */
async function fetchAppRavenIap(trackId: number): Promise<IapAppLookup | null> {
  const data = await appRavenGql(
    `query { appByITunesId(iTunesId: ${trackId}) { title priceTier inAppPurchases { title priceTier } } }`,
  );
  const app = data.appByITunesId as Record<string, unknown> | null | undefined;
  if (!app) return null;
  const iaps: { name: string; tier: number }[] = [];
  const list = app.inAppPurchases;
  if (Array.isArray(list)) {
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) continue;
      const it = raw as Record<string, unknown>;
      if (typeof it.title !== "string" || typeof it.priceTier !== "number") continue;
      iaps.push({ name: it.title.trim(), tier: it.priceTier });
    }
  }
  return {
    trackId,
    title: typeof app.title === "string" ? app.title : "",
    bodyTier: typeof app.priceTier === "number" ? app.priceTier : null,
    iaps,
  };
}

/** Apple 官方 RSS 榜单（top-free）。AppRaven 的排序池只覆盖头部与
 *  新上架，榜单把「主流行」的免费 App 也带进来，防止漏掉不在池里的。 */
async function fetchTopFreeIds(cc: string, limit = 100): Promise<number[]> {
  try {
    const res = await fetch(
      `https://rss.applemarketingtools.com/api/v2/${cc}/apps/top-free/${limit}/apps.json`,
      { headers: { "User-Agent": IAP_UA }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { feed?: { results?: { id?: unknown }[] } };
    const out: number[] = [];
    for (const r of data.feed?.results ?? []) {
      const id = Number(r.id);
      if (Number.isFinite(id) && id > 0) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/** AppRaven 的三个动态流（变价 / 新上架 / 刚更新）。正在做推广的 App
 *  会出现在这里，是排序池之外最有价值的长尾候选。 */
async function fetchActivityIds(
  field: "appsOnSale" | "newApps" | "updatedApps",
  pages: number,
): Promise<number[]> {
  const argSets: Record<string, string> = {
    appsOnSale: "rareOnly: false, miniFilter: {ratingCount: 0}, ",
    newApps: "miniFilter: {ratingCount: 0}, ",
    updatedApps: "rareOnly: false, miniFilter: {ratingCount: 0}, ",
  };
  const out: number[] = [];
  for (let page = 0; page < pages; page++) {
    try {
      const data = await appRavenGql(
        `query { ${field}(${argSets[field]}page: ${page}) { hasNext content { app { ITunesId } } } }`,
      );
      const list = data[field] as Record<string, unknown> | undefined;
      const content = list?.content;
      if (!Array.isArray(content)) break;
      for (const raw of content) {
        if (typeof raw !== "object" || raw === null) continue;
        const app = (raw as Record<string, unknown>).app as Record<string, unknown> | undefined;
        if (app && typeof app.ITunesId === "number") out.push(app.ITunesId);
      }
      if (list?.hasNext !== true) break;
    } catch {
      break;
    }
  }
  return out;
}

/** 每个内购的价格观察：tier 是最后一次看到的档位，paidTier 是最后
 *  一次看到的收费档位，zeroSince 是这一轮连续 0 元的起点。 */
type IapObs = { tier: number; paidTier?: number; zeroSince?: string };
type IapHistoryEntry = { firstSeen: string; items: Record<string, IapObs> };
type IapHistory = Record<string, IapHistoryEntry>;

function readIapHistory(): IapHistory {
  try {
    const raw = JSON.parse(readFileSync(iapDataPath("iap-price-history.json"), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as IapHistory) : {};
  } catch {
    return {};
  }
}

function writeJsonData(file: string, value: unknown): void {
  try {
    const target = iapDataPath(file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value), "utf8");
  } catch {
    // 写不进去只影响下一次的判断质量，不影响本次条目
  }
}

/** 扫描游标：每轮从上次停下的位置继续，池子 2000 多个 App 分几轮扫完，
 *  不用一次把 action 拖到几分钟。 */
function readIapCursor(): number {
  try {
    const raw = JSON.parse(readFileSync(iapDataPath("iap-scan-state.json"), "utf8")) as { cursor?: number };
    return typeof raw.cursor === "number" && raw.cursor >= 0 ? raw.cursor : 0;
  } catch {
    return 0;
  }
}

/** 0 元的权益/恢复/试用项常年如此，不是「限免」；只有名字看着像
 *  「解锁完整版 / 会员 / 终身」的 0 元内购，才在没见过它收费时也列出来。 */
function iapNameLooksLikeUnlock(name: string): boolean {
  if (/restore|恢复|t-?mobile|promo|special offer|优惠|trial|免费试用|免费领取/i.test(name)) return false;
  return /pro\b|premium|plus|unlock|lifetime|forever|full|complete|annual|yearly|monthly|会员|永久|终身|完整|高级|专业|解锁|升级/i.test(
    name,
  );
}

/** 内购领取步骤。 */
function iapInstructions(appName: string, zeroNames: string[], bodyFree: boolean): string {
  const list = zeroNames.map((n) => `· ${n}`).join("\n");
  return (
    (bodyFree ? "" : `先在 App Store 获取《${appName}》（本体免费）。\n`) +
    `打开 App，进入「升级 / Pro / 解锁完整版」内购页（有的在设置里）。\n` +
    `下面这些内购项目当前标价 ¥0.00，选中它走正常购买流程即可，0 元不扣款：\n${list}\n` +
    `0 元内购同样记在这个 Apple 账号下；换机或重装后在 App 内点「恢复购买」即可找回。\n` +
    `内购价格取自 App Store 官方应用页，开发者随时可能改回原价 —— 下单前以购买弹窗显示的金额为准。`
  );
}

/** 从未见过它收费的内购，连续这么多天都是 0 元就当长期免费，下架。 */
const IAP_UNKNOWN_ZERO_DAYS = 10;

type IapHit = {
  trackId: number;
  zeroNames: string[];
  limited: boolean;
  wasCents: number | null;
};

/** 一轮内购限免扫描。返回 null 只在「发现层整体不可用」时（保留上次
 *  结果）；listed = 0 是正常的「这一批没有内购 0 元」。 */
async function syncIosIapFree(
  ctx: Ctx,
  opts: { limit?: number } = {},
): Promise<{ listed: number; checked: number; failed: number; cursor: number; pool: number } | null> {
  const limit = opts.limit ?? 320;
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({
      externalId: schema.deals.externalId,
      claimUrl: schema.deals.claimUrl,
      tags: schema.deals.tags,
      regions: schema.deals.regions,
    })
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));

  const pool = await buildIapPool();
  const poolIds = Object.keys(pool);
  if (poolIds.length === 0) return null;

  // 已收录的条目排在队首：本体限免行要复查是不是也挂着 0 元内购，
  // 内购行要复查是不是还有 0 元项。
  const priority: number[] = [];
  for (const row of existing) {
    if (!row.externalId.startsWith("iosiap-") && !row.externalId.startsWith("iosfree-")) continue;
    const fromUrl = /\/id(\d{6,})/.exec(row.claimUrl ?? "");
    const id = fromUrl ? Number(fromUrl[1]) : Number(/(\d{6,})$/.exec(row.externalId)?.[1] ?? NaN);
    if (Number.isFinite(id)) priority.push(id);
  }
  const cursor0 = readIapCursor();
  const rotated = [...poolIds.slice(cursor0), ...poolIds.slice(0, cursor0)];
  const targets: number[] = [];
  const queued = new Set<number>();
  for (const id of [...priority, ...rotated.map(Number)]) {
    if (!Number.isFinite(id) || queued.has(id)) continue;
    queued.add(id);
    targets.push(id);
    if (targets.length >= limit) break;
  }

  let failed = 0;
  let cursor = 0;
  const hits: IapHit[] = [];
  const history = readIapHistory();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  await Promise.all(
    Array.from({ length: Math.min(6, targets.length) }, async () => {
      while (cursor < targets.length) {
        const trackId = targets[cursor++];
        if (trackId == null) break;
        let look: IapAppLookup | null;
        try {
          look = await fetchAppRavenIap(trackId);
        } catch {
          failed++;
          continue;
        }
        if (!look) continue;
        const hist = history[String(trackId)] ?? { firstSeen: nowIso, items: {} };
        let zeroNames: string[] = [];
        let limited = false;
        let wasCents: number | null = null;
        for (const iap of look.iaps) {
          const obs = hist.items[iap.name] ?? { tier: iap.tier };
          if (iap.tier === 0) {
            if (obs.tier > 0) {
              obs.paidTier = obs.tier;
              obs.zeroSince = nowIso;
            } else if (!obs.zeroSince) {
              obs.zeroSince = nowIso;
            }
            const stale =
              obs.zeroSince != null &&
              nowMs - new Date(obs.zeroSince).getTime() > IAP_UNKNOWN_ZERO_DAYS * 86_400_000;
            if (obs.paidTier != null && obs.paidTier > 0) {
              // 强信号：我们亲眼见过它收费，现在 0 元 → 就是限时内购限免。
              zeroNames.push(iap.name);
              limited = true;
              const usd = APPLE_US_PRICE_POINTS[obs.paidTier];
              if (usd != null) wasCents = Math.max(wasCents ?? 0, Math.round(usd * 100));
            } else if (!stale && iapNameLooksLikeUnlock(iap.name)) {
              // 弱信号：从没见它收过费，只收「看起来是解锁完整版」的项
              // ——「Platinum Restore」「T-Mobile 权益」这类常年 0 元的
              // 权益项不是限免，别占列表。
              zeroNames.push(iap.name);
            }
          } else {
            obs.paidTier = iap.tier;
            delete obs.zeroSince;
          }
          obs.tier = iap.tier;
          hist.items[iap.name] = obs;
        }
        history[String(trackId)] = hist;
        // 本体必须免费：内购 0 元但 App 本体收费对用户没意义（还得先掏
        // 钱买 App），也不符合「限免」的直觉。
        const bodyFree = look.bodyTier === 0 || (look.bodyTier == null && (pool[String(trackId)]?.priceTier ?? null) === 0);
        if (zeroNames.length > 0 && bodyFree) hits.push({ trackId, zeroNames, limited, wasCents });
      }
    }),
  );

  // 发现层大面积失败 = AppRaven 侧不可达，保留上次结果不动。
  if (targets.length >= 20 && failed / targets.length > 0.8) return null;

  // ---- 核验层：只用 Apple 官方页面确认「现在确实是 0 元」----
  const verified: { trackId: number; appleZero: string[]; appleAll: IapPriceItem[]; hit: IapHit }[] = [];
  let verifyCursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, Math.max(1, hits.length)) }, async () => {
      while (verifyCursor < hits.length) {
        const hit = hits[verifyCursor++];
        if (!hit) break;
        try {
          const all = await fetchAppStoreIap(hit.trackId, "cn");
          const zero = all.filter((i) => i.cents === 0).map((i) => i.name);
          if (zero.length > 0) verified.push({ trackId: hit.trackId, appleZero: zero, appleAll: all, hit });
        } catch {
          // 单个核验失败就跳过这一条，下一轮再说
        }
      }
    }),
  );

  const meta = new Map<number, IosFreeLookupApp>();
  if (verified.length > 0) {
    const list = await itunesLookupByRegion(verified.map((v) => v.trackId), "cn");
    for (const v of list) meta.set(v.trackId, v);
  }

  const items: UpsertDeal[] = [];
  const mergedFree = new Set<number>();
  const keepIap = new Set<string>();

  for (const v of verified) {
    const info = meta.get(v.trackId);
    // 国区拿不到这个 App（下架/未上架）就不列 —— 领不了的东西没意义。
    if (!info || !info.trackName || info.price !== 0) continue;
    const hist = history[String(v.trackId)];
    const zeroNames = v.appleZero.filter((n) => !/restore|恢复|t-?mobile|promo|special offer|优惠|trial|免费试用/i.test(n));
    if (zeroNames.length === 0) continue;
    const priceLine = v.appleAll
      .filter((i) => i.priceText)
      .map((i) => `${i.name} ${i.priceText}`)
      .join("；");
    const body = `当前 0 元内购（App Store 官方页面实测）：\n${zeroNames.map((n) => `· ${n} ¥0.00`).join("\n")}` +
      (priceLine ? `\n\n全部内购现价：${priceLine}` : "");

    // 已在「本体限免」里 → 合并标签，不建第二条同名卡片。
    const freeRow = existing.find((r) => r.externalId === `iosfree-${v.trackId}`);
    if (freeRow) {
      mergedFree.add(v.trackId);
      const codes = (freeRow.regions ?? "cn").split(",").map((s) => s.trim()).filter(Boolean);
      await db
        .update(schema.deals)
        .set({
          tags: "ios,iap",
          platform: "iOS · 本体限免 + 内购限免",
          instructionsZh: `${iosFreeInstructions(codes)}\n\n${iapInstructions(info.trackName, zeroNames, true)}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.deals.externalId, `iosfree-${v.trackId}`));
      continue;
    }

    const storeUrl =
      info.trackViewUrl && /apps\.apple\.com\/cn\//.test(info.trackViewUrl)
        ? info.trackViewUrl
        : `https://apps.apple.com/cn/app/id${v.trackId}`;
    keepIap.add(`iosiap-${v.trackId}`);
    items.push({
      externalId: `iosiap-${v.trackId}`,
      title: info.trackName,
      description: `${info.description}\n\n${body}`,
      // 标题只放 App 名：卡片上的紫色「内购限免」徽标 + platform 行
      // 已经说明这是内购条目，标题再缀一遍会同一屏出现三次同样的话。
      titleZh: info.trackName,
      descriptionZh: `${info.description}\n\n${body}`,
      instructionsZh: iapInstructions(info.trackName, zeroNames, false),
      tags: "ios,iap",
      platform: v.hit.limited ? "iOS · 内购限免" : "iOS · 内购 0 元",
      source: "App Store 官方页面 · 内购价格核验",
      worthCents: v.hit.wasCents,
      imageUrl: info.artworkUrl512 ?? null,
      gallery: info.screenshotUrls.length > 0 ? JSON.stringify(info.screenshotUrls.slice(0, 10)) : null,
      claimUrl: storeUrl,
      instructions: null,
      publishedAt: hist?.firstSeen ? new Date(hist.firstSeen) : new Date(),
      endAt: null,
      status: "active",
      usersCount: null,
      regions: "cn",
    });
  }

  // 之前挂过内购、这次 Apple 页面没有 0 元项了：本体限免行降级回纯本体
  // 限免，独立的内购行交给 expireMissing 下架。
  for (const row of existing) {
    const tags = row.tags.split(",");
    if (!row.externalId.startsWith("iosfree-") || !tags.includes("iap")) continue;
    const id = Number(/(\d{6,})$/.exec(row.externalId)?.[1] ?? NaN);
    if (Number.isFinite(id) && mergedFree.has(id)) continue;
    const codes = (row.regions ?? "cn").split(",").map((s) => s.trim()).filter(Boolean);
    await db
      .update(schema.deals)
      .set({
        tags: "ios",
        platform: "iOS · App Store",
        instructionsZh: iosFreeInstructions(codes),
        updatedAt: new Date(),
      })
      .where(eq(schema.deals.externalId, row.externalId));
  }

  writeJsonData("iap-price-history.json", history);
  const nextCursor = (cursor0 + targets.length) % poolIds.length;
  writeJsonData("iap-scan-state.json", { cursor: nextCursor, updatedAt: nowIso, pool: poolIds.length });

  await upsertDeals(ctx, items);
  await expireMissing(ctx, ["iosiap-"], keepIap);
  return {
    listed: items.length + mergedFree.size,
    checked: targets.length,
    failed,
    cursor: nextCursor,
    pool: poolIds.length,
  };
}

// ---------- cloud / AI brand logos (auto-resolved from the official domain) ----------

// ---------- cloud / AI brand logos (auto-resolved from the official domain) ----------
// For every cloud/ai-tagged deal with an official claim link, the brand
// logo is resolved from the link's domain and stored in deals.logo_url.
// Resolution order follows the live measurements of 2026-11-08 (all 11
// curated brands probed): the site's own apple-touch-icon / favicon
// first, then DuckDuckGo's icon service, then Google's favicon service
// at sz=128. (Clearbit's logo API was probed too and is unreachable
// from this egress — connection fails for every domain — so it is not
// in the chain.) Every candidate is fetched and must answer 200 with an
// image content type; among the valid ones the largest pixel size wins
// (PNG/ICO headers are parsed for dimensions; other formats count as
// 48px), ties keep the earlier, more authoritative source. A domain
// that yields nothing keeps the designed gradient + initial cover —
// another brand's art is never substituted.

function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return host.toLowerCase();
  const cc2 = new Set(["com", "co", "net", "org", "gov", "edu", "ac"]);
  if (parts[parts.length - 1]?.length === 2 && cc2.has(parts[parts.length - 2] ?? "")) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/** Pixel size of a PNG (IHDR) or the largest frame of an ICO; null when
 *  the format carries no easily readable size (JPEG/WebP/GIF/SVG). */
function imagePixelSize(buf: Uint8Array): number | null {
  // PNG: 89 50 4E 47, width/height are BE uint32 at bytes 16/20.
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return Math.max(dv.getUint32(16), dv.getUint32(20));
  }
  // ICO: 00 00 01 00, then count at byte 4; each 16-byte entry starts
  // with width/height bytes (0 means 256).
  if (buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
    const count = buf[4]! | (buf[5]! << 8);
    let best = 0;
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      if (off + 1 >= buf.length) break;
      best = Math.max(best, buf[off] === 0 ? 256 : buf[off]!, buf[off + 1] === 0 ? 256 : buf[off + 1]!);
    }
    return best > 0 ? best : null;
  }
  return null;
}

async function probeLogoCandidate(url: string): Promise<{ url: string; size: number } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      // These probes run serially (up to ~96 candidates) inside refreshDeals.
      // One unresponsive brand domain must not stall the entire refresh.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 150) return null; // 1px placeholders / empty icons
    // Unknown-size formats (WebP/JPEG) count as 48 so a parsed 60px+
    // PNG/ICO from the brand's own site still beats them.
    return { url, size: imagePixelSize(buf) ?? 48 };
  } catch {
    return null;
  }
}

async function resolveBrandLogo(claimUrl: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(claimUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  const hosts = [...new Set([host, registrableDomain(host)])];
  const candidates: string[] = [];
  for (const h of hosts) candidates.push(`https://${h}/apple-touch-icon.png`);
  for (const h of hosts) candidates.push(`https://${h}/favicon.ico`);
  for (const h of hosts) candidates.push(`https://icons.duckduckgo.com/ip3/${h}.ico`);
  for (const h of hosts) candidates.push(`https://www.google.com/s2/favicons?domain=${h}&sz=128`);
  let best: { url: string; size: number } | null = null;
  for (const url of candidates) {
    const hit = await probeLogoCandidate(url);
    if (hit && (!best || hit.size > best.size)) best = hit;
  }
  return best?.url ?? null;
}

/** Fill logo_url for active cloud/ai deals that still lack one (curated
 *  entries on their first sync, custom finds when they appear). Failed
 *  domains are retried at most weekly via a meta marker, mirroring the
 *  gallery-enrichment tried-marker pattern. */
async function backfillBrandLogos(ctx: Ctx): Promise<number> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["active", "upcoming"]));
  const targets = rows.filter(
    (r) =>
      !r.logoUrl &&
      r.claimUrl &&
      r.tags.split(",").some((t) => t === "cloud" || t === "ai"),
  );
  let done = 0;
  const startedAt = Date.now();
  for (const row of targets.slice(0, 12)) {
    // Overall budget: logos are cosmetic enrichment and must never hold up
    // a refresh. Unfinished entries are picked up on the next cycle.
    if (Date.now() - startedAt > 45_000) break;
    const triedKey = `logo_tried:${row.externalId}`;
    const tried = await db.select().from(schema.meta).where(eq(schema.meta.key, triedKey)).limit(1);
    const triedAt = tried[0] ? Number(tried[0].value) : 0;
    if (triedAt && Date.now() - triedAt < 7 * 24 * 3600 * 1000) continue;
    const logo = await resolveBrandLogo(row.claimUrl!);
    if (logo) {
      await db.update(schema.deals).set({ logoUrl: logo }).where(eq(schema.deals.id, row.id));
      done++;
    } else {
      await db
        .insert(schema.meta)
        .values({ key: triedKey, value: String(Date.now()) })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(Date.now()) } });
    }
  }
  return done;
}

// ---------- platform accounts + game library ----------
// Login model: the user signs in on the platform's OWN login page, opened as
// a popup from the Mine page; this app never sees a platform password.
// Tokens are stored only in the server-side accounts table and never
// returned to the client; the client sees display name, masked key tail and
// sync status only.
//
// Why the authorization code cannot be captured automatically in a web page
// (verified against the live Epic endpoints on 2026-11-07; native apps like
// Heybox/Heroic can do it because an embedded webview lets the app read
// navigations and page content — a browser page cannot):
//  - GET /id/api/redirect returns the code as a JSON body ON epicgames.com
//    ({"authorizationCode": …, "redirectUrl": "https://localhost/launcher/
//    authorized"}). The redirect target is fixed to the launcher's localhost
//    URL: passing any redirect_uri is rejected with HTTP 400
//    "redirect_uri is not allowed", so no server-side callback landing page
//    can ever receive the code.
//  - Epic's login pages send `x-frame-options: SAMEORIGIN` and
//    `cross-origin-opener-policy: same-origin`, so the login page can
//    neither be embedded in an iframe nor keep an opener handle a page could
//    read from; the same-origin policy independently blocks reading a
//    cross-origin popup's URL or document (only close()/closed are exposed),
//    and Epic's pages never postMessage the code to an opener.
// The client therefore does the closest equivalent: popup stays open, and
// ONE click on 「完成绑定」 reads the clipboard content the user copied on
// Epic's post-login page and submits it here; a manual paste field remains
// only as a fallback when clipboard reading is unavailable.

// Epic launcher client (public client id/secret shipped in the Epic Games
// Launcher and in Legendary/Heroic — not a user credential).
const EPIC_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const EPIC_CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
const EPIC_TOKEN_URL = "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
// The one redirect URL registered for the launcher client (launcherAppClient2)
// and the exact value Epic puts in the login JSON's `redirectUrl`. NOTE: the
// proven exchange shape used by Legendary / Heroic / every maintained client
// of this flow sends NO redirect_uri at all (the authorization request made
// by /id/api/redirect carries none, so there is nothing to match). The first
// version of this code added redirect_uri on RFC reasoning, but that could
// never be validated with test codes: Epic checks a code's existence BEFORE
// any redirect validation (verified live 2026-11-07 — bogus codes return
// `authorization_code_not_found` with no redirect_uri, with this one, and
// with a deliberately wrong one alike), so a real code is the first thing
// that ever reaches the redirect check, and an unsolicited redirect_uri is
// a plausible reason real exchanges kept failing identically. epicLogin
// therefore exchanges with the Legendary shape first and retries once WITH
// this value only when Epic's own error complains about the redirect.
const EPIC_REDIRECT_URI = "https://localhost/launcher/authorized";
export const EPIC_LOGIN_URL = `https://www.epicgames.com/id/api/redirect?clientId=${EPIC_CLIENT_ID}&responseType=code`;
// Popup entry point: Epic's own login page, which returns the browser to
// the code endpoint above after sign-in.
export const EPIC_POPUP_LOGIN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(EPIC_LOGIN_URL)}`;

// GOG Galaxy client (public client id/secret shipped in GOG Galaxy and in
// Heroic/lgogdownloader — not a user credential).
const GOG_CLIENT_ID = "46899977096215655";
const GOG_CLIENT_SECRET = "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";
export const GOG_LOGIN_URL = `https://auth.gog.com/auth?client_id=${GOG_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&response_type=code&layout=client2`;

type PlatformKey = "epic" | "steam" | "gog";
const PLATFORM_LABEL: Record<PlatformKey, string> = { epic: "Epic", steam: "Steam", gog: "GOG" };
type AccountRow = typeof schema.accounts.$inferSelect;

async function getAccountRow(ctx: Ctx, userId: number, platform: PlatformKey): Promise<AccountRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.platform, platform)));
  return rows[0] ?? null;
}

async function saveAccountRow(
  ctx: Ctx,
  userId: number,
  platform: PlatformKey,
  patch: Partial<Omit<AccountRow, "platform" | "userId">>,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await getAccountRow(ctx, userId, platform);
  if (existing) {
    await db
      .update(schema.accounts)
      .set({ ...patch, updatedAt: Date.now() })
      .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.platform, platform)));
  } else {
    await db.insert(schema.accounts).values({ userId, platform, ...patch, updatedAt: Date.now() });
  }
}

/** Accept a bare code, a pasted JSON blob (Epic shows {"authorizationCode": …})
 *  or a pasted redirect URL (GOG lands on …?code=…). */
function extractAuthCode(input: string): string {
  const s = input.trim();
  if (!s) return "";
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s) as Record<string, unknown>;
      const code = j.authorizationCode ?? j.code;
      if (typeof code === "string" && code) return code.trim();
    } catch {
      // fall through to regex
    }
  }
  const m = s.match(/[?&#]code=([^&\s"#]+)/);
  if (m && m[1]) return decodeURIComponent(m[1]);
  const j = s.match(/"authorizationCode"\s*:\s*"([^"]+)"/);
  if (j && j[1]) return j[1];
  // Bare-code fallback. GOG's authorization codes are base64-ish and may
  // contain + / = ; the old [A-Za-z0-9._~-] whitelist silently rejected them
  // and reported "没有读到授权码" even though a valid code had arrived from
  // the native WebView. Still reject prose / CJK / absurd lengths.
  const bare = s.replace(/\s+/g, "");
  return /^[A-Za-z0-9._~+\/=%-]{8,512}$/.test(bare) ? bare : "";
}

/** Epic OAuth failure carrying Epic's OWN error fields verbatim (HTTP status,
 *  errorCode, errorMessage/error_description, plus the full response body for
 *  cases like corrective_action_required that carry a continuationUrl), so
 *  the UI can show the user the real reason — expired code, bad parameters,
 *  an extra step Epic demands — instead of a generic “登录报错”. */
class EpicOAuthError extends Error {
  status: number;
  errorCode: string | null;
  data: Record<string, unknown>;
  constructor(status: number, errorCode: string | null, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "EpicOAuthError";
    this.status = status;
    this.errorCode = errorCode;
    this.data = data;
  }
}

async function epicTokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const basic = Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(EPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit",
    },
    body: new URLSearchParams({ ...body, token_type: "eg1" }).toString(),
  });
  const raw = await res.text().catch(() => "");
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // non-JSON body (e.g. a proxy/challenge page) — the raw text is the error
  }
  if (!res.ok || typeof data.access_token !== "string") {
    const msg =
      typeof data.errorMessage === "string" && data.errorMessage
        ? data.errorMessage
        : typeof data.error_description === "string" && data.error_description
          ? data.error_description
          : raw.trim()
            ? raw.trim().slice(0, 300)
            : `Epic token 接口 HTTP ${res.status}`;
    const errorCode =
      typeof data.errorCode === "string" && data.errorCode
        ? data.errorCode
        : typeof data.error === "string" && data.error
          ? data.error
          : null;
    throw new EpicOAuthError(res.status, errorCode, msg, data);
  }
  return data;
}

/** One-line rendering of an Epic OAuth failure for the UI: HTTP status +
 *  Epic's errorCode + Epic's own message, verbatim. */
function epicErrorText(e: unknown): string {
  if (e instanceof EpicOAuthError) {
    return `HTTP ${e.status}${e.errorCode ? ` · ${e.errorCode}` : ""} · ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------- bind diagnostics ----------
// Every Epic bind attempt's outcome (stage reached + Epic's verbatim error,
// or the success note) is APPENDED to a per-user history in the meta table
// (newest last, capped at 12) and surfaced through getAccounts. The first
// version of this OVERWROTE a single record per attempt — which destroyed
// exactly the evidence needed on 2026-11-07: the user's screenshot showed
// a failed attempt stamped 15:18:36 UTC, while the only stored record was
// stamped 15:19:33 UTC, proving at least two attempts happened 57s apart
// but leaving their relationship (same code twice? two different codes?)
// unanswerable. Each entry now also carries a one-way fingerprint of the
// submitted code (FNV-1a hash prefix — identifies “same code submitted
// again” without storing anything reversible). Only outcomes + fingerprints
// are stored: never the authorization code itself, never tokens.
type BindDiag = { at: number; ok: boolean; detail: string; fp?: string };

const BIND_DIAG_CAP = 12;

/** One-way fingerprint of a submitted authorization code: enough to tell
 *  “the same code was submitted again” apart from “a different code”, with
 *  no way back to the code (which is a full-access credential). */
function codeFingerprint(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function parseBindDiagHistory(raw: string | undefined): BindDiag[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { attempts?: unknown } & Partial<BindDiag>;
    const list = Array.isArray(parsed.attempts)
      ? parsed.attempts
      : typeof parsed.at === "number" && typeof parsed.detail === "string"
        ? [parsed] // legacy single-record shape written before the history existed
        : [];
    const out: BindDiag[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const d = item as Partial<BindDiag>;
      if (typeof d.at !== "number" || typeof d.detail !== "string") continue;
      out.push({ at: d.at, ok: d.ok === true, detail: d.detail, fp: typeof d.fp === "string" ? d.fp : undefined });
    }
    return out;
  } catch {
    return [];
  }
}

async function readBindDiagHistory(ctx: Ctx, userId: number, scope: "epic" | "steam" | "gog" = "epic"): Promise<BindDiag[]> {
  try {
    const db = ctx.db<typeof schema>();
    const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, `bind_diag_${scope}_${userId}`));
    return parseBindDiagHistory(rows[0]?.value);
  } catch {
    return [];
  }
}

async function saveBindDiag(ctx: Ctx, userId: number, diag: BindDiag, scope: "epic" | "steam" | "gog" = "epic"): Promise<void> {
  try {
    const db = ctx.db<typeof schema>();
    const key = `bind_diag_${scope}_${userId}`;
    const history = await readBindDiagHistory(ctx, userId, scope);
    history.push(diag);
    const value = JSON.stringify({ attempts: history.slice(-BIND_DIAG_CAP) });
    const existing = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
    if (existing.length > 0) {
      await db.update(schema.meta).set({ value }).where(eq(schema.meta.key, key));
    } else {
      await db.insert(schema.meta).values({ key, value });
    }
  } catch {
    // diagnostics must never break the bind flow itself
  }
}

async function epicAccessToken(ctx: Ctx, userId: number, row: AccountRow): Promise<string> {
  if (row.accessToken && row.expiresAt && row.expiresAt > Date.now() + 60000) return row.accessToken;
  if (!row.refreshToken) throw new Error("Epic 登录已过期，请重新绑定");
  const data = await epicTokenRequest({ grant_type: "refresh_token", refresh_token: row.refreshToken });
  const expiresAt = typeof data.expires_at === "string" ? new Date(data.expires_at).getTime() : Date.now() + 8 * 3600000;
  await saveAccountRow(ctx, userId, "epic", {
    accessToken: data.access_token as string,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : row.refreshToken,
    expiresAt,
  });
  return data.access_token as string;
}

/**
 * Epic per-artifact playtime from the launcher library service.
 *
 * Endpoint shape live-verified 2026-11-08 against a real bound account
 * (767-game library): the path the old code used — GET /library/api/
 * public/playtime/account/<accountId> — is answered HTTP 405
 * errors.com.epicgames.common.method_not_allowed by Epic. The working
 * route (the one community clients like PlayCounter, checked against
 * Playnite's source, use) is the same path plus `/all`:
 * GET /library/api/public/playtime/account/<accountId>/all → HTTP 200
 * with a JSON array of { accountId, artifactId, totalTime }.
 * - `artifactId` is the artifact's AppName (the library record codename;
 *   some artifacts' AppName is a 32-hex string) — it matches the playKeys
 *   stored at sync time, NOT the catalogItemId (0/53 id overlap measured).
 * - `totalTime` is SECONDS: measured distribution over the real account
 *   was max 423,226 (≈117.6 h) / median 1,732 (≈29 min); reading it as
 *   minutes would put the median played game at ~29 h, which is not
 *   credible for this library. Converted to whole minutes here.
 * Only games Epic has any play record for appear (53 of 767 owned), so a
 * library game with stored keys but no entry genuinely has no recorded
 * playtime. `ok:false` (with the HTTP status) means Epic did not serve
 * playtime at all — callers must report that honestly instead of
 * inventing numbers.
 */
async function fetchEpicPlaytime(
  token: string,
  accountRef: string,
): Promise<{ ok: boolean; status: number; map: Map<string, number>; entries: number }> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(
      `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${accountRef}/all`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return { ok: false, status: res.status, map, entries: 0 };
    const pdata: unknown = await res.json();
    const list = Array.isArray(pdata) ? pdata : [];
    for (const p of list) {
      if (typeof p !== "object" || p === null) continue;
      const pr = p as Record<string, unknown>;
      const key = pr.artifactId ?? pr.appName ?? pr.appId;
      if (typeof key !== "string") continue;
      if (typeof pr.totalTime === "number") {
        map.set(key, Math.round(pr.totalTime / 60));
        continue;
      }
      const mins = pr.totalPlaytimeMinutes ?? pr.playtimeMinutes;
      if (typeof mins === "number") map.set(key, Math.round(mins));
    }
    return { ok: true, status: res.status, map, entries: map.size };
  } catch {
    return { ok: false, status: 0, map, entries: 0 };
  }
}

/**
 * GOG playtime attempt against Galaxy's gameplay service. Route existence
 * was probed live from the build sandbox (2026-11-07): GET
 * https://gameplay.gog.com/users/<userId>/stats exists and validates
 * auth.gog.com Bearer tokens (a bogus token gets OAuth 401 invalid_grant
 * "The access token provided is invalid." — the same credential class as
 * the stored Galaxy token), while sibling routes (/users/<id>/games,
 * /games/<id>/users/<id>) return 404 "No route found". The response shape
 * is not publicly documented, so parsing is defensive: any object carrying
 * a product id plus a playtime-ish numeric field (minutes, or seconds
 * converted) is collected; anything else yields zero entries and the
 * caller reports the platform as not supporting playtime sync. Nothing is
 * ever estimated.
 */
async function fetchGogPlaytime(
  token: string,
  userId: string,
): Promise<{ ok: boolean; status: number; map: Map<string, number>; note: string }> {
  const map = new Map<string, number>();
  let res: Response;
  try {
    res = await fetch(`https://gameplay.gog.com/users/${encodeURIComponent(userId)}/stats`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
  } catch {
    return { ok: false, status: 0, map, note: "GOG 时长接口连接失败" };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const detail =
      typeof body.error_description === "string" && body.error_description
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : "";
    return { ok: false, status: res.status, map, note: `GOG 时长接口 HTTP ${res.status}${detail ? ` · ${detail}` : ""}` };
  }
  const data: unknown = await res.json().catch(() => null);
  const idOf = (o: Record<string, unknown>): string | null => {
    for (const k of ["productId", "gameId", "game_id", "product_id", "id"]) {
      const v = o[k];
      if (typeof v === "number") return String(v);
      if (typeof v === "string" && v) return v;
    }
    return null;
  };
  const minutesOf = (o: Record<string, unknown>): number | null => {
    for (const k of ["playtimeMinutes", "playtime_minutes", "playedMinutes", "timePlayedMinutes"]) {
      if (typeof o[k] === "number") return o[k] as number;
    }
    for (const k of ["playtimeSeconds", "playtime_seconds", "playedSeconds", "timePlayedSeconds", "playtime", "totalPlaytime", "timePlayed"]) {
      if (typeof o[k] === "number") {
        // Fields named *Seconds are seconds; a bare playtime/totalPlaytime
        // on this service is also counted in seconds by Galaxy.
        return Math.round(((o[k] as number) / 60) * 10) / 10;
      }
    }
    return null;
  };
  const visit = (node: unknown, keyHint: string | null, depth: number): void => {
    if (depth > 3 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, null, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const id = idOf(o) ?? (keyHint && /^\d+$/.test(keyHint) ? keyHint : null);
    const mins = minutesOf(o);
    if (id && mins != null) map.set(id, mins);
    for (const [k, v] of Object.entries(o)) visit(v, k, depth + 1);
  };
  visit(data, null, 0);
  if (map.size === 0) {
    return { ok: false, status: res.status, map, note: "GOG 时长接口返回了无法识别的数据结构" };
  }
  return { ok: true, status: res.status, map, note: "" };
}

// Per-account playtime-sync status per platform, kept in meta so the
// library UI can label a platform honestly ("暂不支持时长同步") based on
// the last real attempt instead of guessing.
type PlaytimeState = "ok" | "unsupported" | "unknown";
async function savePlaytimeStatus(ctx: Ctx, userId: number, platform: PlatformKey, state: PlaytimeState, note: string | null): Promise<void> {
  const db = ctx.db<typeof schema>();
  const key = `playtime_status_${userId}`;
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
  let all: Record<string, { state: PlaytimeState; note: string | null }> = {};
  try {
    if (rows[0]?.value) all = JSON.parse(rows[0].value) as typeof all;
  } catch {
    all = {};
  }
  all[platform] = { state, note };
  const value = JSON.stringify(all);
  if (rows[0]) await db.update(schema.meta).set({ value }).where(eq(schema.meta.key, key));
  else await db.insert(schema.meta).values({ key, value });
}

async function readPlaytimeStatus(ctx: Ctx, userId: number): Promise<Record<string, { state: PlaytimeState; note: string | null }>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, `playtime_status_${userId}`));
  try {
    if (rows[0]?.value) return JSON.parse(rows[0].value) as Record<string, { state: PlaytimeState; note: string | null }>;
  } catch {
    // fall through to empty
  }
  return {};
}

async function syncEpicLibrary(ctx: Ctx, userId: number): Promise<{ count: number; note: string }> {
  const row = await getAccountRow(ctx, userId, "epic");
  if (!row || !row.accountRef) throw new Error("尚未绑定 Epic 账号");
  const token = await epicAccessToken(ctx, userId, row);
  // The items endpoint is cursor-paginated (~100 records per page, with a
  // responseMetadata.nextCursor while more remain). Verified live against a
  // real library: 1,039 records over 11 pages — fetching only the first page
  // silently truncated big libraries at exactly 100. Follow the cursor until
  // Epic stops handing one out (or it repeats), capped at 60 pages.
  type EpicRecord = {
    appName?: unknown;
    catalogItemId?: unknown;
    namespace?: unknown;
    sandboxName?: unknown;
    // Epic's own per-record acquisition timestamp (ISO string). Verified
    // live 2026-11-08 against a real library: ALL 1,039 records carried
    // one (2018-12-14 → 2026-11-07), e.g. Subnautica 2018-12-18 — this is
    // the game's real 入库时间, NOT the day this app happened to sync it.
    acquisitionDate?: unknown;
  };
  const records: EpicRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 60; page++) {
    const pageUrl =
      "https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true" +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const detail =
        typeof errBody.errorMessage === "string" && errBody.errorMessage
          ? errBody.errorMessage
          : typeof errBody.errorCode === "string"
            ? errBody.errorCode
            : "";
      throw new Error(`Epic 游戏库接口 HTTP ${res.status}${detail ? ` · ${detail}` : ""}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const pageRecords = Array.isArray(data.records) ? (data.records as EpicRecord[]) : [];
    records.push(...pageRecords);
    const meta = (data.responseMetadata ?? data.responseMeta ?? {}) as Record<string, unknown>;
    const next = typeof meta.nextCursor === "string" && meta.nextCursor ? meta.nextCursor : null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  // Playtime is best-effort: Epic exposes per-artifact totals on the same host.
  const pt = await fetchEpicPlaytime(token, row.accountRef);
  const playtime = pt.map;
  const playtimeAt = pt.ok ? Date.now() : null;
  // Library records carry NO title/metadata at all (verified live: the
  // records have only appName codenames, catalogItemId, namespace and the
  // product-level sandboxName) — real titles, covers and the game-vs-DLC
  // distinction live in the catalog service. Resolve every owned catalog
  // item per namespace (bulk endpoint, ids chunked, namespaces fetched
  // concurrently, one retry per chunk).
  type EpicCatalogItem = {
    id: string;
    title?: unknown;
    keyImages?: unknown;
    categories?: unknown;
    dlcItemList?: unknown;
    urlSlug?: unknown;
    productSlug?: unknown;
    releaseInfo?: unknown;
    customAttributes?: unknown;
  };
  const byNamespace = new Map<string, Set<string>>();
  for (const rec of records) {
    if (typeof rec.catalogItemId !== "string" || typeof rec.namespace !== "string") continue;
    let set = byNamespace.get(rec.namespace);
    if (!set) {
      set = new Set<string>();
      byNamespace.set(rec.namespace, set);
    }
    set.add(rec.catalogItemId);
  }
  const itemById = new Map<string, EpicCatalogItem>();
  const nsQueue = [...byNamespace.entries()];
  async function fetchNamespace(ns: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const url =
        `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${encodeURIComponent(ns)}/bulk/items?` +
        `${chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&")}&includeDLCDetails=true&country=US&locale=en-US`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) continue;
          const raw: unknown = await res.json();
          const items = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>);
          for (const it of items) {
            if (typeof it === "object" && it !== null && typeof (it as EpicCatalogItem).id === "string") {
              itemById.set((it as EpicCatalogItem).id, it as EpicCatalogItem);
            }
          }
          break;
        } catch {
          // one retry, then the records of this chunk fall back to sandboxName
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const next = nsQueue.shift();
        if (!next) return;
        await fetchNamespace(next[0], [...next[1]]);
      }
    }),
  );
  // An item is DLC/附加内容 when another item's dlcItemList references it
  // (this also catches packs whose own categories misleadingly include
  // "games", e.g. Kingdom Come's HD voice/texture packs) or when its own
  // categories mark it as an add-on. A game本体 is a catalog item with a
  // "games" category that is not DLC by either test — category patterns
  // verified against a real 1,039-record library (937本体 records /
  // 95 DLC records / 7 non-game records: engines, software, soundtracks).
  const dlcIds = new Set<string>();
  for (const it of itemById.values()) {
    if (!Array.isArray(it.dlcItemList)) continue;
    for (const d of it.dlcItemList) {
      if (typeof d === "object" && d !== null && typeof (d as Record<string, unknown>).id === "string") {
        dlcIds.add((d as Record<string, unknown>).id as string);
      }
    }
  }
  const catPaths = (it: EpicCatalogItem): string[] =>
    Array.isArray(it.categories)
      ? it.categories
          .map((c) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>).path : null))
          .filter((p): p is string => typeof p === "string")
      : [];
  // Device-platform evidence for one catalog item, from Epic's own
  // catalog fields — in order: (1) releaseInfo platform lists (the
  // field Heroic/Legendary read: "Windows"/"Mac"/"Linux" → pc,
  // "Android"/"IOS" → mobile); (2) a -android- / -ios- segment in the
  // product slug (urlSlug / productSlug / the productSlug custom
  // attribute — the mobile storefront's own slug convention); (3) a
  // category path naming a mobile platform. No evidence → empty set;
  // the group falls back to "pc" only when NO merged record of the
  // game carries any evidence (Epic's library is PC-first), and mobile
  // claim verification trusts only an explicit "mobile" here.
  const devicePlatformsOf = (it: EpicCatalogItem): Set<"pc" | "mobile"> => {
    const out = new Set<"pc" | "mobile">();
    if (Array.isArray(it.releaseInfo)) {
      for (const rel of it.releaseInfo) {
        if (typeof rel !== "object" || rel === null) continue;
        const plats = (rel as Record<string, unknown>).platform;
        const list = Array.isArray(plats) ? plats : typeof plats === "string" ? [plats] : [];
        for (const p of list) {
          if (typeof p !== "string") continue;
          const v = p.toLowerCase();
          if (v.includes("windows") || v.includes("win32") || v.includes("mac") || v.includes("linux")) out.add("pc");
          if (v.includes("android") || v.includes("ios")) out.add("mobile");
        }
      }
    }
    const slugs: string[] = [];
    if (typeof it.urlSlug === "string") slugs.push(it.urlSlug);
    if (typeof it.productSlug === "string") slugs.push(it.productSlug);
    if (Array.isArray(it.customAttributes)) {
      for (const a of it.customAttributes) {
        if (typeof a === "object" && a !== null && (a as Record<string, unknown>).key === "com.epicgames.app.productSlug") {
          const val = (a as Record<string, unknown>).value;
          if (typeof val === "string") slugs.push(val);
        }
      }
    }
    if (slugs.some((s) => /-(android|ios)-/i.test(s) || /-(android|ios)$/i.test(s))) out.add("mobile");
    if (catPaths(it).some((c) => /(^|\/)(android|ios)(\/|$)/i.test(c))) out.add("mobile");
    return out;
  };
  const pickImage = (keyImages: unknown): string | null => {
    if (!Array.isArray(keyImages)) return null;
    const pick =
      keyImages.find((i) => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === "DieselGameBoxTall") ??
      keyImages.find((i) => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === "DieselGameBox") ??
      keyImages[0];
    return pick && typeof pick === "object" && typeof (pick as Record<string, unknown>).url === "string"
      ? ((pick as Record<string, unknown>).url as string)
      : null;
  };
  const normTitle = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[™®©:–—-]/g, " ")
      .replace(/['’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  // One library row per GAME, not per record: the same game commonly owns
  // several base records (PC + mobile-store items, regional/edition items —
  // e.g. Mutazione ×3, LIMBO in two namespaces). Group本体 records by
  // normalized catalog title and merge them; records the catalog could not
  // resolve fall back to their product sandboxName so an owned game is
  // never dropped silently.
  type GameGroup = { title: string; imageUrl: string | null; appNames: string[]; fallback: boolean; slug: string | null; acquiredMs: number | null; devicePlatforms: Set<"pc" | "mobile"> };
  const groups = new Map<string, GameGroup>();
  let dlcEtcCount = 0;
  for (const rec of records) {
    const appName = typeof rec.appName === "string" ? rec.appName : null;
    // Earliest acquisitionDate across the group's merged records wins —
    // the game entered the Epic library when its first record was granted.
    const recAcquired = typeof rec.acquisitionDate === "string" ? Date.parse(rec.acquisitionDate) : NaN;
    const mergeAcquired = (g: GameGroup) => {
      if (Number.isFinite(recAcquired) && (g.acquiredMs == null || recAcquired < g.acquiredMs)) g.acquiredMs = recAcquired;
    };
    const item = typeof rec.catalogItemId === "string" ? itemById.get(rec.catalogItemId) : undefined;
    if (!item) {
      const fallbackTitle = typeof rec.sandboxName === "string" && rec.sandboxName ? rec.sandboxName : appName;
      if (!fallbackTitle) continue;
      const key = `t:${normTitle(fallbackTitle)}`;
      const g = groups.get(key) ?? { title: fallbackTitle, imageUrl: null, appNames: [], fallback: true, slug: null, acquiredMs: null, devicePlatforms: new Set<"pc" | "mobile">() };
      if (appName) g.appNames.push(appName);
      mergeAcquired(g);
      groups.set(key, g);
      continue;
    }
    const cats = catPaths(item);
    if (dlcIds.has(item.id) || cats.includes("addons") || !cats.includes("games")) {
      dlcEtcCount++;
      continue;
    }
    const title = typeof item.title === "string" && item.title ? item.title : typeof rec.sandboxName === "string" ? rec.sandboxName : null;
    if (!title) continue;
    const key = `t:${normTitle(title)}`;
    const g = groups.get(key) ?? { title, imageUrl: null, appNames: [], fallback: false, slug: null, acquiredMs: null, devicePlatforms: new Set<"pc" | "mobile">() };
    // Union across every record merged into this game: a title owned
    // as both a PC item and a mobile-store item keeps BOTH marks.
    for (const dp of devicePlatformsOf(item)) g.devicePlatforms.add(dp);
    if (!g.imageUrl) g.imageUrl = pickImage(item.keyImages);
    if (!g.slug) {
      const slug = typeof item.urlSlug === "string" && item.urlSlug ? item.urlSlug : typeof item.productSlug === "string" && item.productSlug ? item.productSlug : null;
      if (slug) g.slug = slug;
    }
    if (appName) g.appNames.push(appName);
    mergeAcquired(g);
    groups.set(key, g);
  }
  const db = ctx.db<typeof schema>();
  // INCREMENTAL MERGE (was: delete-all + reinsert). Existing rows keep
  // their row id, created_at (first-sync time) and cached game detail;
  // only display/playtime fields refresh, and acquired_at is (re)written
  // from Epic's own acquisitionDate — a stable platform fact, identical on
  // every sync, so re-syncing can no longer stamp every game with "today".
  // Rows whose game no longer appears in the Epic library are removed.
  const existingRows = await db
    .select()
    .from(schema.libraryItems)
    .where(and(eq(schema.libraryItems.platform, "epic"), eq(schema.libraryItems.source, "sync"), eq(schema.libraryItems.userId, userId)));
  const existingByKey = new Map(existingRows.map((r) => [r.extKey, r]));
  let count = 0;
  for (const [key, g] of groups) {
    let minutes: number | null = null;
    for (const appName of g.appNames) {
      const m = playtime.get(appName);
      if (typeof m === "number") minutes = (minutes ?? 0) + m;
    }
    // The playtime endpoint served data but has no record for this game:
    // that is a real "never played" (0), not an estimate. When the
    // endpoint itself failed, minutes stay null (unknown), never faked.
    if (minutes == null && playtimeAt != null && playtime.size > 0) minutes = 0;
    const playKeys = g.appNames.length > 0 ? JSON.stringify(g.appNames) : null;
    // Stored device-platform mark: the confirmed union, or "pc" when no
    // merged record carried any platform evidence (documented default).
    const devicePlatforms = g.devicePlatforms.size > 0 ? [...g.devicePlatforms].join(",") : "pc";
    const existing = existingByKey.get(key);
    if (existing) {
      const patch: Partial<{ title: string; imageUrl: string | null; storeSlug: string | null; playKeys: string | null; playtimeMinutes: number | null; playtimeUpdatedAt: number | null; acquiredAt: number | null; devicePlatforms: string | null }> = {
        title: g.title,
        playKeys,
        devicePlatforms,
      };
      // Never blank out a known cover/slug with a transient catalog miss.
      if (g.imageUrl) patch.imageUrl = g.imageUrl;
      if (g.slug) patch.storeSlug = g.slug;
      if (minutes != null) {
        patch.playtimeMinutes = minutes;
        patch.playtimeUpdatedAt = playtimeAt;
      }
      if (g.acquiredMs != null) patch.acquiredAt = g.acquiredMs;
      await db.update(schema.libraryItems).set(patch).where(eq(schema.libraryItems.id, existing.id));
      existingByKey.delete(key);
    } else {
      await db
        .insert(schema.libraryItems)
        .values({
          platform: "epic",
          userId,
          title: g.title,
          imageUrl: g.imageUrl,
          playtimeMinutes: minutes,
          playtimeUpdatedAt: minutes != null ? playtimeAt : null,
          playKeys,
          storeSlug: g.slug,
          devicePlatforms,
          acquiredAt: g.acquiredMs,
          source: "sync",
          extKey: key,
        })
        .onConflictDoNothing();
    }
    count++;
  }
  // Whatever is left in the map was not in this sync's library anymore.
  for (const stale of existingByKey.values()) {
    await db.delete(schema.libraryItems).where(eq(schema.libraryItems.id, stale.id));
  }
  if (pt.ok) {
    await savePlaytimeStatus(ctx, userId, "epic", "ok", "时长来自 Epic 官方 library-service 时长接口");
  }
  const note =
    `已同步 Epic 游戏库 ${count} 款（接口共 ${records.length} 条记录，DLC/附加内容 ${dlcEtcCount} 条不计入）` +
    (pt.ok ? `；时长已一并更新（Epic 记录了 ${pt.entries} 款游戏的游玩时长）` : `；时长接口本次未返回数据（HTTP ${pt.status || "连接失败"}），时长未改动`);
  await saveAccountRow(ctx, userId, "epic", { lastSyncAt: Date.now(), lastSyncNote: note });
  return { count, note };
}

async function gogTokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({
    client_id: GOG_CLIENT_ID,
    client_secret: GOG_CLIENT_SECRET,
    redirect_uri: GOG_REDIRECT_URI,
    ...params,
  });
  const res = await fetch(`https://auth.gog.com/token?${qs.toString()}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    // Surface GOG's OWN error code AND description verbatim (e.g.
    // "invalid_grant") — the bind panel's diagnostics show this raw, so a
    // failure never collapses into a bare “失败”.
    const errCode = typeof data.error === "string" && data.error ? data.error : "";
    const errDesc = typeof data.error_description === "string" && data.error_description ? data.error_description : "";
    const detail = [errCode, errDesc].filter(Boolean).join(" · ");
    throw new Error(detail ? `GOG token 接口 HTTP ${res.status} · ${detail}` : `GOG token 接口 HTTP ${res.status}`);
  }
  return data;
}

async function gogAccessToken(ctx: Ctx, userId: number, row: AccountRow): Promise<string> {
  if (row.accessToken && row.expiresAt && row.expiresAt > Date.now() + 60000) return row.accessToken;
  if (!row.refreshToken) throw new Error("GOG 登录已过期，请重新绑定");
  const data = await gogTokenRequest({ grant_type: "refresh_token", refresh_token: row.refreshToken });
  const expiresAt = Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 3600000);
  await saveAccountRow(ctx, userId, "gog", {
    accessToken: data.access_token as string,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : row.refreshToken,
    expiresAt,
  });
  return data.access_token as string;
}

async function syncGogLibrary(ctx: Ctx, userId: number): Promise<{ count: number; note: string }> {
  const row = await getAccountRow(ctx, userId, "gog");
  if (!row) throw new Error("尚未绑定 GOG 账号");
  const token = await gogAccessToken(ctx, userId, row);
  const db = ctx.db<typeof schema>();
  // INCREMENTAL MERGE (was: delete-all + reinsert): existing rows keep
  // their created_at — GOG's product records carry no acquisition date,
  // so created_at IS the honest 「首次入库（同步）」 time and a re-sync
  // must never move it. Rows for games no longer in the GOG library are
  // removed after the merge.
  const existingRows = await db
    .select()
    .from(schema.libraryItems)
    .where(and(eq(schema.libraryItems.platform, "gog"), eq(schema.libraryItems.source, "sync"), eq(schema.libraryItems.userId, userId)));
  const existingByKey = new Map(existingRows.map((r) => [r.extKey, r]));
  // Gather the full owned list first: cover resolution below needs the
  // whole id set before the merge writes anything.
  const owned: { id: string; title: string; slug: string | null; image: string | null }[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 20) {
    const res = await fetch(
      `https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" } },
    );
    if (!res.ok) throw new Error(`GOG 游戏库接口 HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.totalPages === "number") totalPages = data.totalPages;
    const products = Array.isArray(data.products) ? data.products : [];
    for (const raw of products) {
      if (typeof raw !== "object" || raw === null) continue;
      const p = raw as Record<string, unknown>;
      const title = typeof p.title === "string" ? p.title : null;
      const id = typeof p.id === "number" ? String(p.id) : typeof p.id === "string" ? p.id : null;
      if (!title || !id) continue;
      owned.push({
        id,
        title,
        slug: typeof p.slug === "string" && p.slug ? p.slug : null,
        image: typeof p.image === "string" && p.image ? p.image : null,
      });
    }
    page++;
  }
  // COVERS — root cause of the all-broken GOG tiles (measured live
  // 2026-11-08): the old code stored `https:<embed image base>_product_
  // tile_256x256.jpg`, but GOG's image service answers that formatter
  // with HTTP 400 for these hashes (checked on XCOM 2's and Yes, Your
  // Grace's real image hashes), so every stored URL was dead. What IS
  // served (all verified HTTP 200 image/jpeg the same day):
  //   1. the official box art from api.gog.com/v2/games/<id>
  //      (_links.boxArtImage.href — a complete https URL, vertical cover);
  //   2. the embed image base itself + ".jpg" (the raw cover file).
  // Resolution: v2 box art first, embed-base .jpg as fallback. A row
  // needs (re)resolution when its stored cover is missing or carries the
  // dead `_product_tile_` suffix — which is exactly how the 296 rows the
  // user already synced get backfilled on their next sync.
  const coverById = new Map<string, string>();
  const needsCover = owned.filter((o) => {
    const cur = existingByKey.get(o.id)?.imageUrl;
    return !cur || cur.includes("_product_tile_") || !cur.startsWith("https://images");
  });
  for (let i = 0; i < needsCover.length; i += 8) {
    const chunk = needsCover.slice(i, i + 8);
    await Promise.all(
      chunk.map(async (o) => {
        let cover: string | null = null;
        try {
          const vr = await fetch(`https://api.gog.com/v2/games/${encodeURIComponent(o.id)}`, {
            headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          if (vr.ok) {
            const vj = (await vr.json()) as Record<string, unknown>;
            const links = (vj._links ?? {}) as Record<string, unknown>;
            const box = (links.boxArtImage ?? {}) as Record<string, unknown>;
            if (typeof box.href === "string" && box.href.startsWith("https://")) cover = box.href;
          }
        } catch {
          // fall through to the embed-base fallback
        }
        if (!cover && o.image) cover = `https:${o.image}.jpg`;
        if (cover) coverById.set(o.id, cover);
      }),
    );
  }
  let coversFixed = 0;
  let count = 0;
  for (const o of owned) {
    const imageUrl = coverById.get(o.id) ?? null;
    if (imageUrl) coversFixed++;
    const existing = existingByKey.get(o.id);
    if (existing) {
      const patch: Partial<{ title: string; imageUrl: string | null; storeSlug: string | null }> = { title: o.title };
      if (imageUrl) patch.imageUrl = imageUrl;
      if (o.slug) patch.storeSlug = o.slug;
      await db.update(schema.libraryItems).set(patch).where(eq(schema.libraryItems.id, existing.id));
      existingByKey.delete(o.id);
    } else {
      await db
        .insert(schema.libraryItems)
        .values({ platform: "gog", userId, title: o.title, imageUrl, storeSlug: o.slug, source: "sync", extKey: o.id })
        .onConflictDoNothing();
    }
    count++;
  }
  for (const stale of existingByKey.values()) {
    await db.delete(schema.libraryItems).where(eq(schema.libraryItems.id, stale.id));
  }
  // Playtime attempt via Galaxy's gameplay service (route probed live —
  // see fetchGogPlaytime). Applied only when real per-product totals come
  // back; otherwise the platform is honestly marked as not supporting
  // playtime sync and every row keeps a null (unknown) playtime.
  if (row.accountRef) {
    const gp = await fetchGogPlaytime(token, row.accountRef);
    if (gp.ok) {
      const rowsNow = await db
        .select()
        .from(schema.libraryItems)
        .where(and(eq(schema.libraryItems.platform, "gog"), eq(schema.libraryItems.source, "sync"), eq(schema.libraryItems.userId, userId)));
      const at = Date.now();
      for (const r of rowsNow) {
        const mins = gp.map.get(r.extKey);
        if (typeof mins === "number") {
          await db.update(schema.libraryItems).set({ playtimeMinutes: mins, playtimeUpdatedAt: at }).where(eq(schema.libraryItems.id, r.id));
        }
      }
      await savePlaytimeStatus(ctx, userId, "gog", "ok", "时长来自 GOG Galaxy gameplay 接口");
    } else {
      await savePlaytimeStatus(ctx, userId, "gog", "unsupported", `该平台暂不支持时长同步（${gp.note}）`);
    }
  }
  const note = coversFixed > 0 ? `已同步 GOG 游戏库 ${count} 款（封面补齐 ${coversFixed} 款）` : `已同步 GOG 游戏库 ${count} 款`;
  await saveAccountRow(ctx, userId, "gog", { lastSyncAt: Date.now(), lastSyncNote: note });
  return { count, note };
}

function gogErrText(json: Record<string, unknown>, raw: string, status: number): string {
  const pick = (k: string) => (typeof json[k] === "string" && json[k] ? (json[k] as string) : null);
  const core = pick("error_description") ?? pick("reason") ?? pick("message") ?? pick("error");
  if (core) return `HTTP ${status}：${core}`;
  // GOG sometimes answers with a full XHTML error page (HTTP 500). Never leak
  // that markup into the UI — the user saw 900 characters of DOCTYPE.
  const looksHtml = /^\s*<(!doctype|html|\?xml)/i.test(raw);
  if (looksHtml) {
    return status === 500
      ? "HTTP 500：GOG 兑换服务返回了错误页（通常表示这个码已被使用，或本次请求被要求网页验证）"
      : `HTTP ${status}：GOG 返回了错误页`;
  }
  const text = raw.trim();
  return text ? `HTTP ${status}：${text.slice(0, 200)}` : `HTTP ${status}`;
}

/** GOG's machine-readable `reason` codes → plain Chinese. */
function gogReasonText(reason: string): string | null {
  const r = reason.toLowerCase();
  if (r === "code_used" || r === "code_already_used") return "这个兑换码已经被使用过了";
  if (r === "code_not_found" || r === "invalid_code" || r === "code_invalid") return "GOG 查不到这个兑换码，可能少输或输错了字符";
  if (r === "code_expired") return "这个兑换码已经过期了";
  if (r.includes("captcha")) return "GOG 要求网页验证码，自动兑换被拦下";
  return null;
}

type GogCodeState = "used" | "missing" | "expired";

type GogRedeemOutcome =
  | { kind: "redeemed" }
  /** `codeState` is set only when GOG positively identified the code: "used"
   *  proves the code existed and was consumed, "missing" proves it does not
   *  exist. Callers must not treat a library hit as success unless the code
   *  was recognised — a random string must never be reported as redeemed. */
  | { kind: "failed"; status: number; message: string; codeState?: GogCodeState; captcha?: boolean };

/**
 * One real attempt at redeeming a GOG bonus code with the user's stored
 * Galaxy Bearer token, against the SAME endpoints the official redeem page
 * uses — extracted from www.gog.com/redeem's own JS bundle (app.*.js:
 * getCodeDataUrl / getRedeemProductsUrl against gogData.apiHost) and
 * live-probed from the build sandbox on 2026-11-07:
 *   lookup: GET  https://redeem.gog.com/v1/bonusCodes/<code>?language=en-US
 *   redeem: POST https://redeem.gog.com/v1/bonusCodes/<code>  {productIds}
 *   both with `Authorization: Bearer <token>`.
 * Probe evidence: a bogus Bearer gets OAuth `401 invalid_grant "The access
 * token provided is invalid."` from BOTH endpoints — the API validates
 * auth.gog.com access tokens, and the stored Galaxy token is minted by that
 * same token endpoint; with NO token the lookup instead stops earlier at
 * `403 {"reason":"Invalid or no captcha"}` (the web page attaches a
 * Turnstile token). So the Bearer token is the credential this API is built
 * around, but GOG may still demand the captcha on some calls — every failure
 * below returns GOG's own response text; nothing is ever faked as success.
 */
async function gogRedeemAttempt(token: string, code: string): Promise<GogRedeemOutcome> {
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0", Accept: "application/json" };
  const enc = encodeURIComponent(code);
  // 1) Lookup: which products does this code carry (and is it still valid)?
  let productIds: number[] = [];
  const lookup = await fetch(`https://redeem.gog.com/v1/bonusCodes/${enc}?language=en-US`, { headers });
  const lookupText = await lookup.text();
  let lookupJson: Record<string, unknown> = {};
  try {
    lookupJson = JSON.parse(lookupText) as Record<string, unknown>;
  } catch {
    // non-JSON body — gogErrText falls back to the raw text
  }
  if (lookup.status === 401) {
    return { kind: "failed", status: 401, message: gogErrText(lookupJson, lookupText, lookup.status) };
  }
  // GOG states a code's fate on the lookup itself: 404/410 + `reason`
  // (code_used / code_not_found / code_expired). The redeem POST cannot fix
  // any of those — firing it anyway is what produced the raw XHTML "HTTP 500"
  // page shown to the user, so report the real reason and stop here.
  const lookupReason = typeof lookupJson.reason === "string" ? lookupJson.reason : null;
  const captchaBlocked = !!lookupReason && lookupReason.toLowerCase().includes("captcha");
  if (lookupReason && !captchaBlocked) {
    const r = lookupReason.toLowerCase();
    const codeState: GogCodeState | undefined =
      r === "code_used" || r === "code_already_used"
        ? "used"
        : r === "code_not_found" || r === "invalid_code" || r === "code_invalid"
          ? "missing"
          : r === "code_expired"
            ? "expired"
            : undefined;
    return {
      kind: "failed",
      status: lookup.status,
      message: gogReasonText(lookupReason) ?? gogErrText(lookupJson, lookupText, lookup.status),
      codeState,
    };
  }
  if (lookup.ok) {
    const products = Array.isArray(lookupJson.products) ? lookupJson.products : [];
    for (const p of products) {
      if (typeof p !== "object" || p === null) continue;
      const rec = p as Record<string, unknown>;
      const id = rec.id ?? rec.productId;
      if (typeof id === "number") productIds.push(id);
      else if (typeof id === "string" && /^\d+$/.test(id)) productIds.push(Number(id));
    }
    // A code that resolves to nothing has nothing to redeem; posting an empty
    // product list would only earn another opaque error.
    if (productIds.length === 0) {
      return { kind: "failed", status: lookup.status, message: "GOG 没有返回这个码可兑换的内容（可能已被使用或已失效）" };
    }
  }
  // A blocked lookup (e.g. the captcha 403) does not prove the redeem POST is
  // blocked too — still make the real attempt; GOG's own answer decides.
  // 2) Redeem POST.
  const res = await fetch(`https://redeem.gog.com/v1/bonusCodes/${enc}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ productIds }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON body
  }
  if (res.ok) return { kind: "redeemed" };
  return { kind: "failed", status: res.status, message: gogErrText(json, text, res.status), captcha: captchaBlocked };
}

/** Steam publishes TWO different artworks for every app:
 *   • header.jpg              460×215  LANDSCAPE banner (store shelf / news)
 *   • library_600x900_2x.jpg  600×900  PORTRAIT capsule (the library grid)
 *  The library grid is a full-bleed 3:4 cover box, so feeding it the
 *  landscape header cropped every logo in half — exactly the "横屏截取"
 *  look: only the middle strip of the banner survived. Owned-game rows must
 *  use the portrait capsule. Both URLs are deterministic from the appid;
 *  the _2x variant is simply the retina size of the same artwork. */
const steamLibraryCover = (appid: string | number) =>
  `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900_2x.jpg`;

/** Repair rows synced before the portrait switch (and any future row that
 *  somehow still points at header.jpg) at READ time, so already-installed
 *  apps show correct covers without a resync or a new IPA. */
function normalizeLibraryCover(platform: string, imageUrl: string | null, extKey: string | null): string | null {
  if (platform !== "steam") return imageUrl;
  const url = imageUrl ?? "";
  // An empty cover is deliberate: a handful of apps (DLC / tool / VR
  // variants) have NO portrait capsule on Steam's CDN at all. Keep it
  // empty so SafeImg shows its designed placeholder instead of firing a
  // doomed 404 request.
  if (!url) return null;
  const id = url.match(/\/steam\/apps\/(\d+)\//)?.[1] ?? (/^\d+$/.test(extKey ?? "") ? extKey : null);
  if (!id) return imageUrl;
  if (/library_600x900/.test(url)) return imageUrl;
  if (/header\.jpg|capsule_/.test(url)) return steamLibraryCover(id);
  return imageUrl;
}

async function syncSteamLibrary(ctx: Ctx, userId: number): Promise<{ count: number; note: string }> {
  const row = await getAccountRow(ctx, userId, "steam");
  if (!row || !row.accountRef) throw new Error("尚未绑定 Steam 账号");
  if (!row.steamApiKey) {
    const note = "已绑定 SteamID；填入你自己的 Steam Web API Key 后才能同步游戏库";
    await saveAccountRow(ctx, userId, "steam", { lastSyncAt: Date.now(), lastSyncNote: note });
    return { count: 0, note };
  }
  const res = await fetch(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(row.steamApiKey)}&steamid=${encodeURIComponent(row.accountRef)}&include_appinfo=1&include_played_free_games=1&format=json`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`Steam Web API HTTP ${res.status}（Key 无效或资料未公开时会被拒绝）`);
  const data = (await res.json()) as Record<string, unknown>;
  const response = (data.response ?? {}) as Record<string, unknown>;
  const games = Array.isArray(response.games) ? response.games : [];
  if (games.length === 0) {
    const note = "Steam 返回了空游戏库：多半是个人资料里「游戏详情」没有设为公开";
    await saveAccountRow(ctx, userId, "steam", { lastSyncAt: Date.now(), lastSyncNote: note });
    return { count: 0, note };
  }
  // Persona name for the account row (best effort).
  try {
    const sres = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(row.steamApiKey)}&steamids=${encodeURIComponent(row.accountRef)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (sres.ok) {
      const sdata = (await sres.json()) as Record<string, unknown>;
      const players = ((sdata.response as Record<string, unknown> | undefined)?.players ?? []) as Record<string, unknown>[];
      const name = players[0]?.personaname;
      if (typeof name === "string" && name) await saveAccountRow(ctx, userId, "steam", { displayName: name });
    }
  } catch {
    // display name optional
  }
  const db = ctx.db<typeof schema>();
  // INCREMENTAL MERGE (was: delete-all + reinsert): GetOwnedGames returns
  // no acquisition date, so an existing row's created_at is its honest
  // 「首次入库（同步）」 time and must survive every re-sync untouched;
  // only title/playtime refresh. Rows for games no longer returned are
  // removed after the merge.
  const existingRows = await db
    .select()
    .from(schema.libraryItems)
    .where(and(eq(schema.libraryItems.platform, "steam"), eq(schema.libraryItems.source, "sync"), eq(schema.libraryItems.userId, userId)));
  const existingByKey = new Map(existingRows.map((r) => [r.extKey, r]));
  let count = 0;
  for (const raw of games) {
    if (typeof raw !== "object" || raw === null) continue;
    const g = raw as Record<string, unknown>;
    if (typeof g.appid !== "number" || typeof g.name !== "string") continue;
    const key = String(g.appid);
    const existing = existingByKey.get(key);
    if (existing) {
      // A cover already resolved to a portrait capsule (or deliberately
      // left empty for an app with no portrait asset) must survive a
      // re-sync: blindly writing the 2x URL again would bring back a 404
      // for those few apps.
      const coverResolved = /library_600x900/.test(existing.imageUrl ?? "") || !existing.imageUrl;
      await db
        .update(schema.libraryItems)
        .set({
          title: g.name,
          ...(coverResolved ? {} : { imageUrl: steamLibraryCover(g.appid) }),
          playtimeMinutes: typeof g.playtime_forever === "number" ? g.playtime_forever : existing.playtimeMinutes,
          playtimeUpdatedAt: typeof g.playtime_forever === "number" ? Date.now() : existing.playtimeUpdatedAt,
        })
        .where(eq(schema.libraryItems.id, existing.id));
      existingByKey.delete(key);
    } else {
      await db
        .insert(schema.libraryItems)
        .values({
          platform: "steam",
          userId,
          title: g.name,
          imageUrl: steamLibraryCover(g.appid),
          playtimeMinutes: typeof g.playtime_forever === "number" ? g.playtime_forever : null,
          playtimeUpdatedAt: typeof g.playtime_forever === "number" ? Date.now() : null,
          source: "sync",
          extKey: key,
        })
        .onConflictDoNothing();
    }
    count++;
  }
  for (const stale of existingByKey.values()) {
    await db.delete(schema.libraryItems).where(eq(schema.libraryItems.id, stale.id));
  }
  await savePlaytimeStatus(ctx, userId, "steam", "ok", "时长来自 Steam Web API GetOwnedGames 的 playtime_forever");
  const note = `已同步 Steam 游戏库 ${count} 款`;
  await saveAccountRow(ctx, userId, "steam", { lastSyncAt: Date.now(), lastSyncNote: note });
  return { count, note };
}

async function syncPlatform(ctx: Ctx, userId: number, platform: PlatformKey): Promise<{ count: number; note: string }> {
  if (platform === "epic") return syncEpicLibrary(ctx, userId);
  if (platform === "gog") return syncGogLibrary(ctx, userId);
  return syncSteamLibrary(ctx, userId);
}

/** Cap one platform's sync so a single unreachable API (Steam's community
 *  endpoints are often slow or blocked) cannot stall "sync all" forever. */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}：超过 ${Math.round(ms / 1000)} 秒无响应`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- Steam official OpenID login ("Sign in through Steam") ----------
// Steam's official third-party login is OpenID 2.0: the client opens
// https://steamcommunity.com/openid/login?openid.mode=checkid_setup with
// openid.return_to = THIS artifact's own page URL plus a one-time bind
// ticket (issued by steamOpenIdStart, stored in meta, 15-minute TTL,
// single use). The user types their Steam password ONLY on Steam's site;
// Steam then redirects the popup back to the return_to URL carrying a
// signed assertion (openid.mode=id_res + openid.claimed_id + openid.sig).
// Unlike Epic's code page (a body on Epic's own origin behind COOP), the
// return lands on OUR origin, so the returned page instance itself reads
// the params from its own address bar and submits them to
// steamOpenIdVerify — the ticket, not the browser session, identifies
// which in-app account the binding belongs to, so the flow works even
// when the popup lives in a different browser context than the app.
// Verification is Steam's own dumb-mode check: every openid.* param is
// posted back to the same endpoint with openid.mode=check_authentication
// and Steam answers a plain-text `is_valid:true/false` verdict.
// Live-probed from the build sandbox 2026-11-08: a fully forged
// assertion (invented nonce + signature) returns HTTP 200 with
// `is_valid:false`, and the checkid_setup login URL 302s to Steam's
// official login form — the chain is real and only a genuine signed
// assertion passes. No password or credential ever touches this server.
const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_TICKET_TTL_MS = 15 * 60000;

/** Ask Steam to verify a returned OpenID assertion. Returns Steam's own
 *  verdict line; throws only on transport failure. */
async function checkSteamAssertion(params: Record<string, string>): Promise<{ valid: boolean; raw: string }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("openid.")) body.set(k, v);
  }
  body.set("openid.mode", "check_authentication");
  const res = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  const valid = /(^|\n)is_valid:true(\r?\n|$)/.test(raw);
  return { valid, raw: raw.trim().slice(0, 300) };
}

/** Persona name from Steam's PUBLIC profile XML feed — no API key needed
 *  (live-verified 2026-11-08: /profiles/<id>?xml=1 returns <steamID>). */
async function fetchSteamPersonaName(steamId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}?xml=1`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      // 4 秒足够；这个域名在部分网络下会一直挂到超时，不能让它拖住绑定。
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(/<steamID>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/steamID>/);
    const name = m?.[1]?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

/** Consume a one-time Steam bind ticket: returns its owner userId, or null
 *  when the ticket is unknown / expired / already used. The ticket row is
 *  deleted on first use either way, so a replayed return URL cannot bind
 *  twice. */
async function consumeSteamBindTicket(ctx: Ctx, ticket: string): Promise<number | null> {
  if (!/^[a-f0-9]{32,64}$/.test(ticket)) return null;
  const db = ctx.db<typeof schema>();
  const key = `steam_openid_ticket_${ticket}`;
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
  const row = rows[0];
  if (!row) return null;
  await db.delete(schema.meta).where(eq(schema.meta.key, key));
  try {
    const data = JSON.parse(row.value) as { userId?: unknown; exp?: unknown };
    if (typeof data.userId !== "number" || typeof data.exp !== "number") return null;
    if (data.exp <= Date.now()) return null;
    return data.userId;
  } catch {
    return null;
  }
}

function accountStatus(row: AccountRow | null, syncCount: number) {
  if (!row || (!row.accountRef && !row.accessToken)) {
    return {
      bound: false,
      displayName: null as string | null,
      accountRef: null as string | null,
      hasApiKey: false,
      apiKeyMasked: null as string | null,
      syncCount,
      lastSyncAt: null as string | null,
      lastSyncNote: null as string | null,
    };
  }
  return {
    bound: true,
    displayName: row.displayName ?? null,
    accountRef: row.accountRef ?? null,
    hasApiKey: !!row.steamApiKey,
    apiKeyMasked: row.steamApiKey ? `••••${row.steamApiKey.slice(-4)}` : null,
    syncCount,
    lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
    lastSyncNote: row.lastSyncNote ?? null,
  };
}

// ---------- actions ----------

const listResponse = z.object({
  deals: z.array(dealShape),
  lastSyncedAt: z.string().nullable(),
  stats: z.object({
    activeCount: z.number(),
    totalWorthCents: z.number(),
    nextExpiryAt: z.string().nullable(),
    epicFreeCount: z.number(),
  }),
});

const changePasswordResponse = z.object({ ok: z.boolean(), note: z.string() });

const authResponse = z.object({
  ok: z.boolean(),
  token: z.string().nullable(),
  username: z.string().nullable(),
  note: z.string(),
});

const batchVerifyResponse = z.object({
  ok: z.boolean(),
  needLogin: z.boolean(),
  results: z.array(
    z.object({
      dealId: z.number(),
      title: z.string(),
      status: z.enum(["verified", "not_found", "unverifiable", "unprocessed"]),
      note: z.string(),
      // Epic mobile rows that library verification cannot confirm carry
      // the official transactions-page URL here — the authoritative
      // place to check whether the mobile claim actually landed.
      linkUrl: z.string().nullable(),
    }),
  ),
  syncNotes: z.array(z.object({ platform: z.enum(["epic", "steam", "gog"]), note: z.string() })),
});

// Full-catalogue App Store search (Apple iTunes Search API). Read-only: it
// never writes to the tracked watch list. Results are cached briefly per
// storefront + term so typing in the search box doesn't hammer Apple on
// every keystroke.
const APP_SEARCH_COUNTRIES = new Set(["cn", "us", "jp", "hk", "in", "tw", "gb", "kr", "sg", "au"]);
const APP_SEARCH_TTL_MS = 5 * 60_000;
const appSearchCache = new Map<string, { at: number; rows: Record<string, unknown>[] }>();

/* ------------------------------------------------------------------ */
/* App Store 排行榜 / Apple Arcade                                     */
/* ------------------------------------------------------------------ */
// Marketing Tools RSS v2 的 ?genre= 实测不生效（带 6014 仍返回总榜），只有
// v1 iTunes RSS 支持任意 genre（含全部游戏子分类），所以榜单统一走 v1。
const APP_RANKING_COUNTRIES = new Set(["cn", "us", "jp", "hk", "in", "tw", "gb", "kr", "sg", "au"]);
const APP_RANKING_TTL_MS = 10 * 60_000;
const GAME_GENRE_IDS = new Set([
  6014, 7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009,
  7011, 7012, 7013, 7014, 7015, 7016, 7017, 7018, 7019,
]);
type RankingAppOut = {
  rank: number;
  trackId: number;
  name: string;
  iconUrl: string | null;
  storeUrl: string | null;
  sellerName: string | null;
  genre: string | null;
  price: string;
  currency: string;
  releaseDate: string | null;
};
const appRankingCache = new Map<string, { at: number; apps: RankingAppOut[] }>();

// Apple Arcade 没有公开清单 API：官方 apps.apple.com/arcade 在国区会被
// 重定向到 Today，iTunes 元数据也不带 arcade 标记。改为聚合 Apple 官方
// Search API 的 Arcade 相关检索，再用「无独立售价」筛出只能订阅获取的
// 游戏（Arcade 游戏不能单独购买，故 formattedPrice / price 均缺失）。
const ARCADE_TTL_MS = 6 * 60 * 60_000;
const ARCADE_TERMS = ["apple arcade", "apple arcade games", "arcade originals"];
type ArcadeGameOut = {
  trackId: number;
  name: string;
  iconUrl: string | null;
  storeUrl: string | null;
  sellerName: string | null;
  genre: string | null;
  releaseDate: string | null;
  rating: number | null;
  arcadeKind: string;
};
let arcadeCache: { at: number; games: ArcadeGameOut[] } | null = null;

const rankingAppSchema = z.object({
  rank: z.number(),
  trackId: z.number(),
  name: z.string(),
  iconUrl: z.string().nullable(),
  storeUrl: z.string().nullable(),
  sellerName: z.string().nullable(),
  genre: z.string().nullable(),
  price: z.string(),
  currency: z.string(),
  releaseDate: z.string().nullable(),
});
const arcadeGameSchema = z.object({
  trackId: z.number(),
  name: z.string(),
  iconUrl: z.string().nullable(),
  storeUrl: z.string().nullable(),
  sellerName: z.string().nullable(),
  genre: z.string().nullable(),
  releaseDate: z.string().nullable(),
  rating: z.number().nullable(),
  arcadeKind: z.string(),
});

export const Actions = {
  registerAccount: defineAction({
    description: "Registers an in-app account (username + password; password stored only as a salted PBKDF2 hash) and returns a session token. The FIRST registered account adopts the legacy un-owned pool of platform bindings, library rows and marks created before accounts existed.",
    request: z.object({
      username: z.string().min(2).max(24),
      password: z.string().min(6).max(72),
    }),
    response: authResponse,
    async handler(ctx, args): Promise<z.infer<typeof authResponse>> {
      const db = ctx.db<typeof schema>();
      const username = args.username.trim();
      if (username.length < 2) return { ok: false, token: null, username: null, note: "用户名至少 2 个字符" };
      const existing = await db.select().from(schema.users).where(eq(schema.users.username, username));
      if (existing.length > 0) return { ok: false, token: null, username: null, note: "这个用户名已被注册，换一个或直接登录" };
      const allUsers = await db.select({ id: schema.users.id }).from(schema.users);
      const isFirstUser = allUsers.length === 0;
      const inserted = await db
        .insert(schema.users)
        .values({ username, passwordHash: await hashPassword(args.password), createdAt: Date.now() })
        .returning({ id: schema.users.id });
      const user = inserted[0];
      if (!user) throw new Error("registerAccount: insert returned no rows");
      if (isFirstUser) {
        // Adopt the legacy un-owned pool so nothing the user already bound,
        // synced or marked is lost when accounts switch on.
        await db.update(schema.accounts).set({ userId: user.id }).where(eq(schema.accounts.userId, 0));
        await db.update(schema.libraryItems).set({ userId: user.id }).where(eq(schema.libraryItems.userId, 0));
        await db.update(schema.marks).set({ userId: user.id }).where(eq(schema.marks.userId, 0));
      }
      const token = await issueSession(ctx, user.id);
      ctx.invalidateQueries();
      return { ok: true, token, username, note: isFirstUser ? "注册成功，之前的绑定、游戏库和标记已归入这个账号" : "注册成功" };
    },
  }),

  loginAccount: defineAction({
    description: "Logs in to an in-app account with username + password and returns a fresh session token. The account's platform bindings, library and marks are restored automatically because they are stored server-side under the account.",
    request: z.object({
      username: z.string().min(1).max(24),
      password: z.string().min(1).max(72),
    }),
    response: authResponse,
    async handler(ctx, args): Promise<z.infer<typeof authResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.users).where(eq(schema.users.username, args.username.trim()));
      const user = rows[0];
      if (!user || !(await verifyPassword(args.password, user.passwordHash))) {
        return { ok: false, token: null, username: null, note: "用户名或密码不对" };
      }
      const token = await issueSession(ctx, user.id);
      ctx.invalidateQueries();
      return { ok: true, token, username: user.username, note: "登录成功" };
    },
  }),

  logoutAccount: defineAction({
    description: "Logs out an in-app session: the session token is deleted server-side. Bindings, library and marks stay stored under the account for the next login.",
    request: z.object({ authToken: z.string().min(8).max(256) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.sessions).where(eq(schema.sessions.token, args.authToken));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getSessionUser: defineAction({
    description: "Resolves a persisted client session token to the logged-in account's username, avatar (uploaded-image URL, or null for the default placeholder) and remembered UI theme (light/dark, null when never chosen), or nulls when the token is absent, unknown or expired.",
    request: z.object({ authToken: z.string().max(256).optional() }),
    response: z.object({
      username: z.string().nullable(),
      avatar: avatarShape,
      theme: z.enum(["light", "dark"]).nullable(),
    }),
    async handler(ctx, args): Promise<{ username: string | null; avatar: AvatarInfo; theme: "light" | "dark" | null }> {
      const userId = await resolveUserId(ctx, args.authToken);
      if (userId == null) return { username: null, avatar: null, theme: null };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      const user = rows[0];
      if (!user) return { username: null, avatar: null, theme: null };
      const themeRows = await db.select().from(schema.meta).where(eq(schema.meta.key, `ui_theme_${userId}`));
      const theme = themeRows[0]?.value === "light" || themeRows[0]?.value === "dark" ? themeRows[0].value : null;
      return { username: user.username, avatar: await avatarInfo(ctx, user), theme };
    },
  }),

  setUiTheme: defineAction({
    description: "Remembers the signed-in account's light/dark theme choice server-side (meta ui_theme_<userId>) so the choice is restored on the next open and on other devices. Signed-out visitors keep their choice in localStorage on the client instead.",
    request: z.object({ authToken: z.string().min(8).max(256), theme: z.enum(["light", "dark"]) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const userId = await resolveUserId(ctx, args.authToken);
      if (userId == null) throw new Error("先登录站内账号再保存主题偏好");
      const db = ctx.db<typeof schema>();
      const key = `ui_theme_${userId}`;
      const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
      if (rows[0]) await db.update(schema.meta).set({ value: args.theme }).where(eq(schema.meta.key, key));
      else await db.insert(schema.meta).values({ key, value: args.theme });
      return { ok: true as const };
    },
  }),

  setAvatar: defineAction({
    description: "Changes the signed-in account's avatar: mode image stores an uploaded picture (base64 JPEG/PNG/WebP, already centre-cropped and compressed client-side, hard cap 200KB) as a blob under the account, mode clear returns to the default initial-letter placeholder. Upload is the only way to set a picture (built-in presets were removed). The choice lives on the account, so it follows the user across devices and re-logins.",
    request: z.object({
      authToken: z.string().min(8).max(256),
      mode: z.enum(["image", "clear"]),
      imageBase64: z.string().max(400000).optional(),
    }),
    response: z.object({ ok: z.boolean(), note: z.string(), avatar: avatarShape }),
    async handler(ctx, args): Promise<{ ok: boolean; note: string; avatar: AvatarInfo }> {
      const userId = await resolveUserId(ctx, args.authToken);
      if (userId == null) return { ok: false, note: "先登录站内账号再换头像", avatar: null };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      const user = rows[0];
      if (!user) return { ok: false, note: "账号不存在", avatar: null };

      if (args.mode === "clear") {
        await db.update(schema.users).set({ avatar: null }).where(eq(schema.users.id, userId));
        ctx.invalidateQueries();
        return { ok: true, note: "已恢复默认头像", avatar: null };
      }

      // mode === "image"
      if (!args.imageBase64) return { ok: false, note: "没有收到图片", avatar: await avatarInfo(ctx, user) };
      const bytes = decodeBase64Image(args.imageBase64);
      if (!bytes) return { ok: false, note: "图片太大或格式不对：请换一张（上限 200KB）", avatar: await avatarInfo(ctx, user) };
      if (bytes.length > AVATAR_MAX_BYTES) {
        return { ok: false, note: `图片有 ${Math.ceil(bytes.length / 1024)}KB，超过 200KB 上限`, avatar: await avatarInfo(ctx, user) };
      }
      const contentType = sniffImageType(bytes);
      if (!contentType) return { ok: false, note: "只支持 JPG / PNG / WebP 图片", avatar: await avatarInfo(ctx, user) };
      await ctx.blobs.put(`avatars/${userId}`, bytes, { contentType });
      await db.update(schema.users).set({ avatar: "image" }).where(eq(schema.users.id, userId));
      ctx.invalidateQueries();
      const url = await ctx.blobs.getUrl(`avatars/${userId}`);
      return { ok: true, note: "头像已更换", avatar: url ? { preset: null, imageUrl: url } : null };
    },
  }),

  changePassword: defineAction({
    description: "Changes the signed-in account's password: the current password is verified against the stored salted PBKDF2 hash first (a wrong current password changes nothing and is reported honestly), then the new password is stored as a fresh salted hash. Every OTHER session of the account is deleted (other devices are signed out); the session making the change stays signed in.",
    request: z.object({
      authToken: z.string().min(8).max(256),
      currentPassword: z.string().min(1).max(72),
      newPassword: z.string().min(6).max(72),
    }),
    response: changePasswordResponse,
    async handler(ctx, args): Promise<z.infer<typeof changePasswordResponse>> {
      const userId = await resolveUserId(ctx, args.authToken);
      if (userId == null) return { ok: false, note: "先登录站内账号再修改密码" };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      const user = rows[0];
      if (!user) return { ok: false, note: "账号不存在" };
      if (!(await verifyPassword(args.currentPassword, user.passwordHash))) {
        return { ok: false, note: "当前密码不正确，密码没有改动" };
      }
      if (args.newPassword === args.currentPassword) {
        return { ok: false, note: "新密码和当前密码一样，没有改动" };
      }
      await db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(args.newPassword) })
        .where(eq(schema.users.id, userId));
      // Sign out every other device; this device's session survives.
      await db
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.token, args.authToken)));
      ctx.invalidateQueries();
      return { ok: true, note: "密码已修改，其他设备上的登录已退出，这台设备保持登录" };
    },
  }),

  listDeals: defineAction({
    description: "Lists all current free deals (games, iOS apps, DLC, cloud free tiers, AI token free quotas, custom finds) with the signed-in account's saved/claimed marks (or the legacy pool when signed out) and summary stats.",
    request: z.object({ ...authArg }),
    response: listResponse,
    async handler(ctx, args): Promise<z.infer<typeof listResponse>> {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const rows = await db
        .select()
        .from(schema.deals)
        .where(inArray(schema.deals.status, ["active", "upcoming"]))
        .orderBy(desc(schema.deals.publishedAt));
      // GamerPower 会把 Epic 官方当周免费游戏重复收录成
      // "… (Epic Games) Giveaway"，并在 platform 里一并带上 Android/iOS，
      // 于是被前端标成「手游」；但它的 open_giveaway_url 只是跳到 Epic
      // PC 商店页（不是 0 元结算页），又因为标题同名，用户领了 PC 版
      // 就会被自动标成「已领取」——看起来就像「没领手游却显示已领」。
      // 官方 epic-* 条目本身信息更全（真实 offerId + purchase 结算页），
      // 所以把这类与在架官方 PC 条目同名的 GP 重复赠礼从列表里去掉，
      // 只保留干净的官方条目，避免误导成手游限免。
      const officialEpicTitles = new Set(
        rows
          .filter((r) => r.externalId.startsWith("epic-") && !r.externalId.startsWith("epic-mobile-") && r.status === "active")
          .map((r) => normName(baseTitle(r.title)))
          .filter((k) => k.length > 0),
      );
      const visibleRows =
        officialEpicTitles.size === 0
          ? rows
          : rows.filter((r) => {
              if (!r.externalId.startsWith("gp-")) return true;
              if (!/epic games/i.test(r.platform) && !/\(epic games\)/i.test(r.title)) return true;
              return !officialEpicTitles.has(normName(baseTitle(r.title)));
            });
      const markRows = await db.select().from(schema.marks).where(eq(schema.marks.userId, uid));
      const savedIds = new Set(markRows.filter((m) => m.kind === "saved").map((m) => m.dealId));
      const claimedIds = new Set(markRows.filter((m) => m.kind === "claimed").map((m) => m.dealId));
      const hiddenIds = new Set(markRows.filter((m) => m.kind === "hidden").map((m) => m.dealId));
      const metaRows = await db.select().from(schema.meta).where(eq(schema.meta.key, "last_synced_at"));
      const watchRows = await db.select({ dealExternalId: schema.appWatch.dealExternalId }).from(schema.appWatch);
      const itunesMatchedDealIds = new Set(watchRows.map((w) => w.dealExternalId).filter((x): x is string => !!x));
      // In-library determination for game deals (drives the games page's
      // 已入库 badge in multi-select mode): a deal counts as in the
      // library when it is marked claimed here AND files under a library
      // group, or when a synced/manual library row of the same group
      // carries the same normalized title — i.e. the game verifiably sits
      // in the bound platform account (or was added here before).
      const libItemRows = await db
        .select({ platform: schema.libraryItems.platform, title: schema.libraryItems.title, devicePlatforms: schema.libraryItems.devicePlatforms })
        .from(schema.libraryItems)
        .where(eq(schema.libraryItems.userId, uid));
      // Two views of the same library, split by device entitlement. Epic
      // syncs a PC copy of a free game (devicePlatforms "pc") and, when
      // the mobile giveaway is claimed, a mobile-marked row ("mobile").
      // A MOBILE deal must only be lit up by a mobile-marked row — owning
      // the PC free game of the same title must NOT mark the mobile
      // giveaway 已领取. This mirrors verifyBatchClaim's mobile rule.
      const libTitles = new Map<string, Set<string>>();
      const libMobileTitles = new Map<string, Set<string>>();
      const addKeys = (map: Map<string, Set<string>>, platform: string, title: string) => {
        const set = map.get(platform) ?? new Set<string>();
        set.add(normName(title));
        set.add(normName(baseTitle(title)));
        map.set(platform, set);
      };
      for (const it of libItemRows) {
        addKeys(libTitles, it.platform, it.title);
        const devs = (it.devicePlatforms ?? "").split(",").map((d) => d.trim());
        if (devs.includes("mobile")) addKeys(libMobileTitles, it.platform, it.title);
      }
      const isMobileDeal = (r: (typeof rows)[number]): boolean => {
        if (r.externalId.startsWith("epic-mobile-")) return true;
        if (/\(mobile\)/i.test(r.title) || /手游版|手游商城/i.test(r.title + " " + (r.titleZh ?? "") + " " + r.platform)) return true;
        const offers = parseEpicOffers(r.epicOffers);
        if (offers.length > 0 && offers.every((o) => o.platform === "android" || o.platform === "ios")) return true;
        return false;
      };
      const inLibraryIds = new Set<number>();
      for (const r of visibleRows) {
        const tags = r.tags.split(",");
        if (!tags.includes("game") && !tags.includes("dlc")) continue;
        const group = libraryGroupOfDeal(r);
        if (!group) continue;
        if (claimedIds.has(r.id)) {
          inLibraryIds.add(r.id);
          continue;
        }
        // Prime channels are matched too (amazon / legacy): a Prime game
        // already sitting in the account's library must get the same
        // 已在库 badge the Epic/Steam/GOG ones get.
        const set = isMobileDeal(r) ? libMobileTitles.get(group) : libTitles.get(group);
        if (!set) continue;
        const keys = [normName(baseTitle(r.title)), ...(r.titleZh ? [normName(baseTitle(r.titleZh))] : [])];
        if (keys.some((k) => k.length > 0 && set.has(k))) inLibraryIds.add(r.id);
      }
      const deals = visibleRows.map((r) => toDeal(r, savedIds, claimedIds, hiddenIds, itunesMatchedDealIds, inLibraryIds));
      const nowMs = Date.now();
      const timed = visibleRows.filter((r) => r.endAt && r.status === "active" && r.endAt.getTime() > nowMs);
      const nextExpiry = timed.length
        ? timed.reduce((a, b) => ((a.endAt as Date) < (b.endAt as Date) ? a : b))
        : null;
      return {
        deals,
        lastSyncedAt: metaRows[0]?.value ?? null,
        stats: {
          activeCount: visibleRows.filter((r) => r.status === "active").length,
          totalWorthCents: visibleRows
            .filter((r) => r.status === "active")
            .reduce((sum, r) => sum + (r.worthCents ?? 0), 0),
          nextExpiryAt: nextExpiry?.endAt ? nextExpiry.endAt.toISOString() : null,
          epicFreeCount: visibleRows.filter((r) => r.externalId.startsWith("epic-") && r.status === "active").length,
        },
      };
    },
  }),

  refreshDeals: defineAction({
    description: "Re-fetches free deals from GamerPower and the Epic free-games feed, upserts them, expires vanished ones, ensures the curated cloud and AI token free-tier entries exist, and runs the Prime Gaming monthly member-games check (re-upserts the verified lineup, flips launched games to claimable, auto-expires games past their claim deadline). Epic rows (PC + the mobile storefront's own weekly freebies, fetched from the EGS platform-service discover feed) carry their real namespace/offerId, and their claim links are Epic purchase deep links assembled from those ids. It also syncs the iOS App Store limited-time-free list (AppRaven candidates, each verified free on Apple's official CN Lookup before listing; rows that stop verifying expire) and backfills brand logos for cloud/AI entries from their official domains.",
    request: z.object({}),
    response: z.object({
      gamerpowerCount: z.number(),
      epicCount: z.number(),
      epicMobileCount: z.number(),
      iosFreeCount: z.number(),
      iapFreeCount: z.number(),
      syncedAt: z.string(),
      errors: z.array(z.string()),
    }),
    async handler(ctx) {
      const errors: string[] = [];
      let gp: UpsertDeal[] = [];
      let epic: UpsertDeal[] = [];
      try {
        gp = await fetchGamerPower();
        // Merge platform-filtered feeds so Steam / GOG / Epic-store rows the
        // date-sorted full feed rotated out are still picked up.
        const seenGp = new Set(gp.map((g) => g.externalId));
        for (const param of ["steam", "gog", "epic-games-store"]) {
          const extra = await fetchGamerPowerPlatform(param);
          for (const item of extra) {
            if (!seenGp.has(item.externalId)) {
              seenGp.add(item.externalId);
              gp.push(item);
            }
          }
        }
      } catch (e) {
        errors.push(`GamerPower 同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        epic = await fetchEpic();
      } catch (e) {
        errors.push(`Epic 同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
      // Epic MOBILE storefront freebies (separate weekly program, own
      // official discover source). The discover host is Cloudflare-
      // gated and intermittently refuses this runtime's direct fetch
      // (403 / connection reset, measured repeatedly) — when that
      // happens the sync hands the fetch to a background agent task,
      // which reads the same official endpoints through its own web
      // tools and stores the result via saveEpicMobileSnapshot (the
      // single store path, storeEpicMobileDeals). Previous mobile rows
      // are kept untouched until one of the two paths lands data.
      let epicMobile: UpsertDeal[] = [];
      let epicMobileOk = false;
      try {
        epicMobileDiag = "";
        const m = await fetchEpicMobile();
        epicMobileOk = m.ok;
        epicMobile = m.deals;
        if (!m.ok) {
          let spawned = false;
          try {
            const r = await ctx.agent.spawnTask(
              "抓取 Epic 手游商城官方 discover 源的四个 JSON 并回存到本空间（「游戏应用限免推送」）。四个地址（Epic 官方 EGS platform-service discover 接口）：\n" +
                "1. https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=US&locale=en&platform=android&start=0&store=EGS\n" +
                "2. https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=US&locale=en&platform=ios&start=0&store=EGS\n" +
                "3. https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=CN&locale=en&platform=android&start=0&store=EGS\n" +
                "4. https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=CN&locale=en&platform=ios&start=0&store=EGS\n" +
                "用你可用的工具取回每个地址的完整 JSON（例如 exec 里 curl，或浏览器打开）。对每个 JSON 只保留 data 数组中 type 为 \"freeGame\" 的条目，组成 {\"data\":[...]} 的精简 JSON（字段值一个都不要改）。然后调用本空间动作 saveEpicMobileSnapshot 一次：usAndroid 传地址 1 的精简 JSON，usIos 传地址 2，cnAndroid 传地址 3，cnIos 传地址 4；某个地址实在取不到就传 null。完成后简要报告动作返回的 count 与 locked 列表。",
              { expectsAction: "saveEpicMobileSnapshot", dedupeKey: "epic-mobile-discover-fetch" },
            );
            spawned = r.ok;
          } catch {
            spawned = false;
          }
          errors.push(
            spawned
              ? "Epic 手游同步：官方 discover 源直连被拦，已转后台抓取，完成后手游条目与锁区标记自动更新"
              : `Epic 手游同步失败：官方 discover 源本次未返回数据（${epicMobileDiag || "无响应"}），已保留上次的手游条目`,
          );
        }
      } catch (e) {
        errors.push(`Epic 手游同步失败：${e instanceof Error ? e.message : String(e)}（已保留上次的手游条目）`);
      }
      // Epic claim links are now the purchase deep links fetchEpic
      // assembled from the real offer ids. The old GamerPower-link
      // borrowing survives ONLY as a fallback for a row that somehow
      // has no claim link at all (GP titles look like
      // "Flotsam (Epic Games) Giveaway" — exact title match only).
      const normalize = (t: string) =>
        t.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s*giveaways?\s*$/i, "").trim();
      const gpByTitle = new Map(gp.map((g) => [normalize(g.title), g.claimUrl]));
      for (const e of epic) {
        if (e.claimUrl) continue;
        const url = gpByTitle.get(normalize(e.title));
        if (url) e.claimUrl = url;
      }
      // Translate every English title/description/instructions into Chinese before upserting.
      const fetched: UpsertDeal[] = [...gp, ...epic, ...epicMobile];
      const toTranslate = [...epic, ...gp].filter((d) => needsTranslation(`${d.title} ${d.description}`));
      if (toTranslate.length > 0) {
        const trMap = await translateItems(ctx, toTranslate);
        for (const d of fetched) {
          const tr = trMap.get(d.externalId);
          if (tr) {
            d.titleZh = tr.titleZh || null;
            d.descriptionZh = tr.descriptionZh || null;
            d.instructionsZh = tr.instructionsZh;
          }
        }
      }
      if (gp.length > 0) {
        await upsertDeals(ctx, gp);
        await expireMissing(ctx, ["gp-"], new Set(gp.map((g) => g.externalId)));
      }
      if (epic.length > 0) {
        await upsertDeals(ctx, epic);
        await expireMissing(ctx, ["epic-"], new Set(epic.map((e) => e.externalId)));
      }
      if (epicMobileOk) {
        await storeEpicMobileDeals(ctx, epicMobile);
      }
      // Deterministic end state for GP duplicates of mobile giveaways,
      // whatever order this run's fetches landed in (see
      // mirrorStoredEpicMobileDeals).
      try {
        await mirrorStoredEpicMobileDeals(ctx);
      } catch {
        // best effort — the next refresh re-applies it
      }
      await upsertDeals(
        ctx,
        CURATED.map((c) => ({
          ...c,
          titleZh: c.titleZh ?? (needsTranslation(c.title) ? null : c.title),
          descriptionZh: c.descriptionZh ?? (needsTranslation(c.description) ? null : c.description || null),
          instructionsZh: c.instructionsZh ?? c.instructions ?? null,
        })),
      );
      // Brand logos for cloud / AI entries (auto-resolved from each
      // entry's official domain; failures keep the designed cover).
      // Runs early — right after the curated rows exist — so a slow
      // sync still lands the logos.
      try {
        await backfillBrandLogos(ctx);
      } catch {
        // best effort
      }
      // Prime Gaming monthly member games: re-upsert the verified lineup
      // (status derived from the launch date so an announced game flips to
      // claimable on its day), then auto-expire rows past their claim
      // deadline or no longer in the lineup.
      const nowMs = Date.now();
      await upsertDeals(
        ctx,
        PRIME_GAMES.map((c) => ({
          ...c,
          claimUrl: PRIME_CLAIM_URLS[c.externalId] ?? c.claimUrl,
          status: (c.publishedAt && c.publishedAt.getTime() > nowMs ? "upcoming" : "active") as "active" | "upcoming",
          titleZh: c.titleZh ?? (needsTranslation(c.title) ? null : c.title),
          descriptionZh: c.descriptionZh ?? (needsTranslation(c.description) ? null : c.description || null),
          instructionsZh: c.instructionsZh ?? c.instructions ?? null,
        })),
      );
      try {
        await expirePrimeLineup(ctx);
      } catch {
        // best effort
      }
      // Backfill any older rows still missing a Chinese translation.
      try {
        await backfillTranslations(ctx);
      } catch {
        // best effort
      }
      // Fetch official store screenshots + game/app intros for rows still missing them.
      try {
        await enrichGalleryRows(ctx, { limit: 20 });
      } catch {
        // best effort
      }
      // Record today's App Store price snapshots for the iOS price-drop watch.
      try {
        await snapshotAppPrices(ctx);
      } catch {
        // best effort
      }
      // iOS App Store 限时免费: AppRaven candidates, each re-verified
      // against the official CN Lookup (price === 0) before listing;
      // rows that stop verifying are expired by the same pass. A source
      // failure (null) keeps the previous rows and is reported honestly.
      let iosFreeCount = 0;
      try {
        const ios = await syncIosFreeApps(ctx);
        if (ios) {
          iosFreeCount = ios.listed;
        } else {
          errors.push("iOS 限免同步失败：AppRaven 源本次未取到数据，已保留上次的限免条目");
        }
      } catch (e) {
        errors.push(`iOS 限免同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
      // iOS 内购限免：抓 App Store 官方应用页里的内购价格，本体内购
      // 标 0 元的条目单列（与本体限免用 tags 区分）。放在最后跑，源不
      // 可用时只少这一块，前面已落库的结果不受影响。
      let iapFreeCount = 0;
      try {
        const iap = await syncIosIapFree(ctx, { limit: 80 });
        if (iap) iapFreeCount = iap.listed;
      } catch (e) {
        errors.push(`iOS 内购限免同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
      const syncedAt = new Date().toISOString();
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.meta)
        .values({ key: "last_synced_at", value: syncedAt })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: syncedAt } });
      ctx.invalidateQueries();
      return {
        gamerpowerCount: gp.length,
        epicCount: epic.length,
        epicMobileCount: epicMobile.length,
        iosFreeCount,
        iapFreeCount,
        syncedAt,
        errors,
      };
    },
  }),

  saveEpicMobileSnapshot: defineAction({
    description: "Stores one Epic mobile-store discover snapshot fetched by a background task (refreshDeals spawns it when the Cloudflare-gated discover host refuses the server's direct fetch): takes the four official discover payloads (US + CN × android + iOS, each already trimmed to the freeGame topic or null when a fetch failed), parses them with the same parser as the direct sync, computes each giveaway's region-lock verdict from the CN topic's listed slugs (present in US but absent from CN = locked, stored region_locked = 1; listed in CN = 0; CN unknown = stored flag preserved), upserts the epic-mobile rows, expires vanished ones, and mirrors the purchase deep link + lock flag onto GamerPower duplicates of the same giveaway.",
    request: z.object({
      usAndroid: z.unknown().optional(),
      usIos: z.unknown().optional(),
      cnAndroid: z.unknown().optional(),
      cnIos: z.unknown().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      count: z.number(),
      locked: z.array(z.string()),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const usA = args.usAndroid != null ? parseEpicMobileDiscover(args.usAndroid, "android") : null;
      const usI = args.usIos != null ? parseEpicMobileDiscover(args.usIos, "ios") : null;
      const cnA = args.cnAndroid != null ? parseEpicMobileDiscover(args.cnAndroid, "android") : null;
      const cnI = args.cnIos != null ? parseEpicMobileDiscover(args.cnIos, "ios") : null;
      const built = buildEpicMobileDeals(usA, usI, cnA, cnI);
      if (!built.ok) {
        return { ok: false, count: 0, locked: [] as string[], note: "US 侧 discover 数据缺失或无 freeGame 专题，未写入任何手游条目" };
      }
      await storeEpicMobileDeals(ctx, built.deals);
      ctx.invalidateQueries();
      return {
        ok: true,
        count: built.deals.length,
        locked: built.deals.filter((d) => d.regionLocked === 1).map((d) => d.title),
        note: "已按官方 discover 数据落库：US 在列、CN 同源缺席的手游限免已标锁区并写入 region_locked",
      };
    },
  }),

  enrichGallery: defineAction({
    description: "Fetches real official store screenshots and a Chinese intro for game/app deals that still lack them (Epic feed images, Steam store, App Store). Pass a dealId to enrich just one deal (used when its detail page opens), otherwise enriches the next batch of missing deals.",
    request: z.object({
      dealId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(40).optional(),
    }),
    response: z.object({ updated: z.number(), withImages: z.number() }),
    async handler(ctx, args) {
      const r = await enrichGalleryRows(ctx, { dealId: args.dealId, limit: args.limit ?? 20 });
      if (r.updated > 0) ctx.invalidateQueries();
      return r;
    },
  }),

  translateDeals: defineAction({
    description: "Translates any stored deals that still only have English titles/descriptions into Chinese and saves the translations.",
    request: z.object({}),
    response: z.object({ translated: z.number() }),
    async handler(ctx) {
      const n = await backfillTranslations(ctx);
      ctx.invalidateQueries();
      return { translated: n };
    },
  }),

  toggleMark: defineAction({
    description: "Toggles a saved (收藏), claimed (已领) or hidden (不感兴趣) mark on one deal for the signed-in account (or the legacy pool when signed out) and returns the deal's new mark states.",
    request: z.object({
      dealId: z.number().int().positive(),
      kind: z.enum(["saved", "claimed", "hidden"]),
      ...authArg,
    }),
    response: z.object({ dealId: z.number(), saved: z.boolean(), claimed: z.boolean(), hidden: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const sel = and(
        eq(schema.marks.dealId, args.dealId),
        eq(schema.marks.kind, args.kind),
        eq(schema.marks.userId, uid),
      );
      const existing = await db.select().from(schema.marks).where(sel);
      if (existing.length > 0) {
        await db.delete(schema.marks).where(sel);
      } else {
        await db.insert(schema.marks).values({ dealId: args.dealId, kind: args.kind, userId: uid });
      }
      const all = await db
        .select()
        .from(schema.marks)
        .where(and(eq(schema.marks.dealId, args.dealId), eq(schema.marks.userId, uid)));
      ctx.invalidateQueries();
      return {
        dealId: args.dealId,
        saved: all.some((m) => m.kind === "saved"),
        claimed: all.some((m) => m.kind === "claimed"),
        hidden: all.some((m) => m.kind === "hidden"),
      };
    },
  }),

  claimPrimeGame: defineAction({
    description: "Marks one Prime Gaming member game as claimed for the signed-in account (used by the one-click Prime claim queue after the user confirms the claim on Amazon's official claim page). Idempotent: an already-claimed game stays claimed. The game then shows in the Mine library under its redemption channel (Epic / GOG / Amazon Games App / Legacy Games).",
    request: z.object({ dealId: z.number().int().positive(), ...authArg }),
    response: z.object({
      ok: z.boolean(),
      channel: z.enum(["epic", "gog", "amazon", "legacy", "other"]).nullable(),
      channelLabel: z.string().nullable(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const rows = await db.select().from(schema.deals).where(eq(schema.deals.id, args.dealId));
      const deal = rows[0];
      if (!deal || !deal.externalId.startsWith("prime-")) {
        return { ok: false, channel: null, channelLabel: null, note: "这不是一款 Prime 会员游戏" };
      }
      const channel = primeChannelOf(deal.platform);
      await db
        .insert(schema.marks)
        .values({ dealId: deal.id, kind: "claimed", userId: uid })
        .onConflictDoNothing();
      ctx.invalidateQueries();
      return {
        ok: true,
        channel,
        channelLabel: PRIME_CHANNEL_LABEL[channel],
        note: `已标记领取，将按 ${PRIME_CHANNEL_LABEL[channel]} 渠道出现在游戏库`,
      };
    },
  }),

  listPrimeClaimQueue: defineAction({
    description: "Returns the Prime one-click claim queue for the signed-in account: Prime Gaming member games that are claimable now (not upcoming, not past their claim deadline) and not yet claimed by this account, sorted by claim deadline, each with its official per-game claim deep link and redemption channel.",
    request: z.object({ ...authArg }),
    response: z.object({
      items: z.array(
        z.object({
          dealId: z.number(),
          externalId: z.string(),
          title: z.string(),
          titleZh: z.string().nullable(),
          imageUrl: z.string().nullable(),
          channel: z.enum(["epic", "gog", "amazon", "legacy", "other"]),
          channelLabel: z.string(),
          claimUrl: z.string().nullable(),
          endAt: z.string().nullable(),
          // The game already sits in the library of the channel it would be
          // redeemed into: the queue labels it 已在库中 instead of 已领.
          inLibrary: z.boolean(),
        }),
      ),
      total: z.number(),
      claimedCount: z.number(),
      epicBound: z.boolean(),
      gogBound: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const now = Date.now();
      const rows = await db
        .select()
        .from(schema.deals)
        .where(eq(schema.deals.status, "active"))
        .orderBy(asc(schema.deals.endAt));
      const prime = rows.filter(
        (r) => r.externalId.startsWith("prime-") && (!r.endAt || r.endAt.getTime() > now),
      );
      const claimedRows = await db
        .select()
        .from(schema.marks)
        .where(and(eq(schema.marks.kind, "claimed"), eq(schema.marks.userId, uid)));
      const claimedIds = new Set(claimedRows.map((m) => m.dealId));
      // Which of these Prime games already sit in the library of the channel
      // they redeem into (Epic / GOG / Amazon Games App / Legacy Games)?
      // Title-normalized so "Game: Deluxe" and "Game" still match.
      const primeLibRows = await db
        .select({ platform: schema.libraryItems.platform, title: schema.libraryItems.title })
        .from(schema.libraryItems)
        .where(eq(schema.libraryItems.userId, uid));
      const primeLibTitles = new Map<string, Set<string>>();
      for (const it of primeLibRows) {
        const set = primeLibTitles.get(it.platform) ?? new Set<string>();
        set.add(normName(it.title));
        set.add(normName(baseTitle(it.title)));
        primeLibTitles.set(it.platform, set);
      }
      const inLibraryOf = (title: string, channel: string): boolean => {
        const set = primeLibTitles.get(channel);
        if (!set) return false;
        return [normName(title), normName(baseTitle(title))].some((k) => k.length > 0 && set.has(k));
      };
      const items = prime
        .filter((r) => !claimedIds.has(r.id))
        .map((r) => {
          const channel = primeChannelOf(r.platform);
          return {
            dealId: r.id,
            externalId: r.externalId,
            title: r.title,
            titleZh: r.titleZh ?? null,
            imageUrl: r.imageUrl ?? null,
            channel,
            channelLabel: PRIME_CHANNEL_LABEL[channel],
            claimUrl: PRIME_CLAIM_URLS[r.externalId] ?? r.claimUrl ?? null,
            endAt: r.endAt ? r.endAt.toISOString() : null,
            inLibrary: inLibraryOf(r.title, channel) || (r.titleZh ? inLibraryOf(r.titleZh, channel) : false),
          };
        })
        // Deadline order; games without a published deadline go last.
        .sort((a, b) => {
          if (!a.endAt && !b.endAt) return 0;
          if (!a.endAt) return 1;
          if (!b.endAt) return -1;
          return new Date(a.endAt).getTime() - new Date(b.endAt).getTime();
        });
      const epicRow = await getAccountRow(ctx, uid, "epic");
      const gogRow = await getAccountRow(ctx, uid, "gog");
      return {
        items,
        total: prime.length,
        claimedCount: prime.length - items.length,
        epicBound: !!(epicRow && epicRow.accountRef),
        gogBound: !!(gogRow && gogRow.accountRef),
      };
    },
  }),

  clearHiddenMarks: defineAction({
    description: "Removes every not-interested (hidden) mark of the signed-in account (or the legacy pool) so all previously hidden deals show again.",
    request: z.object({ ...authArg }),
    response: z.object({ ok: z.literal(true), cleared: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; cleared: number }> {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const sel = and(eq(schema.marks.kind, "hidden"), eq(schema.marks.userId, uid));
      const rows = await db.select().from(schema.marks).where(sel);
      if (rows.length > 0) {
        await db.delete(schema.marks).where(sel);
      }
      ctx.invalidateQueries();
      return { ok: true as const, cleared: rows.length };
    },
  }),

  addCustomDeal: defineAction({
    description: "Adds a user-found freebie (own title, category, link, optional original price, expiry and note) to the deal wall.",
    request: z.object({
      title: z.string().min(1).max(200),
      category: z.enum(["game", "ios", "cloud", "ai", "dlc", "other"]),
      claimUrl: z.string().url().optional(),
      worthCents: z.number().int().nonnegative().nullable().optional(),
      endDate: z.string().nullable().optional(),
      note: z.string().max(1000).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const externalId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const endAt = args.endDate ? new Date(`${args.endDate}T23:59:59`) : null;
      const result = await db
        .insert(schema.deals)
        .values({
          externalId,
          title: args.title,
          description: args.note ?? "",
          tags: args.category,
          platform: "",
          source: "手动添加",
          worthCents: args.worthCents ?? null,
          claimUrl: args.claimUrl ?? null,
          publishedAt: new Date(),
          endAt: endAt && !Number.isNaN(endAt.getTime()) ? endAt : null,
          status: "active",
        })
        .returning({ id: schema.deals.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addCustomDeal: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteCustomDeal: defineAction({
    description: "Deletes one user-added custom deal (and its marks). Synced deals cannot be deleted.",
    request: z.object({ dealId: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.deals).where(eq(schema.deals.id, args.dealId));
      const row = rows[0];
      if (!row || !row.externalId.startsWith("custom-")) {
        throw new Error("只能删除手动添加的条目");
      }
      await db.delete(schema.marks).where(eq(schema.marks.dealId, args.dealId));
      await db.delete(schema.deals).where(eq(schema.deals.id, args.dealId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
  refreshIosIapFree: defineAction({
    description:
      "Scans the iOS in-app-purchase free list on its own: opens Apple's official App Store page for each candidate app (the rows already listed as iOS free, AppRaven's live price-change feed, and AppRaven's newest in-app-purchase apps), reads the in-app purchase block Apple server-renders into that page (name + current price), and lists every app whose body is free in the CN storefront and that currently prices at least one in-app purchase at zero. Rows attached to an existing iOS-free row are merged onto it (tags ios,iap) instead of duplicating the card; rows that stop pricing anything at zero are expired or downgraded. Prices are Apple's own, checked on every run.",
    request: z.object({ limit: z.number().int().min(20).max(400).optional() }),
    response: z.object({ ok: z.boolean(), listed: z.number(), checked: z.number(), failed: z.number() }),
    async handler(ctx, args) {
      const r = await syncIosIapFree(ctx, { limit: args.limit ?? 320 });
      ctx.invalidateQueries();
      if (!r) return { ok: false, listed: 0, checked: 0, failed: 0 };
      return { ok: true, listed: r.listed, checked: r.checked, failed: r.failed };
    },
  }),

  refreshIosFreeApps: defineAction({
    description: "Syncs the iOS App Store limited-time-free list on its own: pulls current paid→free drops from AppRaven, verifies each against Apple's official iTunes Lookup (country=cn, current price must be 0), lists the verified ones with official Lookup name/icon/description/screenshots, and expires rows that no longer verify. When the source fetch fails, previous rows are kept and ok=false is returned.",
    request: z.object({}),
    response: z.object({ ok: z.boolean(), listed: z.number(), checked: z.number() }),
    async handler(ctx) {
      const r = await syncIosFreeApps(ctx);
      ctx.invalidateQueries();
      if (!r) return { ok: false, listed: 0, checked: 0 };
      return { ok: true, listed: r.listed, checked: r.checked };
    },
  }),

  backfillBrandLogos: defineAction({
    description: "Resolves and stores brand logos for active cloud/AI entries that still lack one, from each entry's official claim-link domain (site's own touch icon / favicon first, then DuckDuckGo icons, then Google's favicon service; every candidate is fetched and must return a real image). Entries whose domain yields no logo keep their designed gradient cover and are retried at most weekly.",
    request: z.object({}),
    response: z.object({ filled: z.number() }),
    async handler(ctx) {
      const filled = await backfillBrandLogos(ctx);
      ctx.invalidateQueries();
      return { filled };
    },
  }),

  // One-shot combined runner for the two backfill chains above, so a
  // single durable-data pass (post-submit) can land BOTH the first iOS
  // limited-time-free batch AND the cloud/AI brand logos — previously the
  // two standalone actions were only ever exercised against the sandbox
  // copy and production never received either result. Runs the exact same
  // underlying functions as refreshIosFreeApps / backfillBrandLogos and
  // touches nothing else.
  backfillIosFreeAndLogos: defineAction({
    description: "Runs the iOS App Store limited-time-free sync and the cloud/AI brand-logo backfill in one pass (the same work as refreshIosFreeApps + backfillBrandLogos) and reports how many iOS free apps were listed/checked and how many logos were filled.",
    request: z.object({}),
    response: z.object({
      iosOk: z.boolean(),
      iosListed: z.number(),
      iosChecked: z.number(),
      logosFilled: z.number(),
    }),
    async handler(ctx) {
      const ios = await syncIosFreeApps(ctx);
      const logosFilled = await backfillBrandLogos(ctx);
      ctx.invalidateQueries();
      return {
        iosOk: ios !== null,
        iosListed: ios?.listed ?? 0,
        iosChecked: ios?.checked ?? 0,
        logosFilled,
      };
    },
  }),

  refreshAppPrices: defineAction({
    description: "Records today's App Store prices (iTunes Lookup API, no key needed) for the tracked iOS apps — a fixed popular paid-app watchlist plus in-feed iOS deals matched by exact name — so real price drops can be shown.",
    request: z.object({}),
    response: z.object({ tracked: z.number() }),
    async handler(ctx) {
      const r = await snapshotAppPrices(ctx);
      ctx.invalidateQueries();
      return r;
    },
  }),

  listAppPrices: defineAction({
    description: "Returns tracked iOS apps with their current App Store price versus the highest price recorded so far; only apps whose current price is below that recorded high are flagged as real price drops.",
    request: z.object({}),
    response: z.object({
      apps: z.array(
        z.object({
          trackId: z.number(),
          name: z.string(),
          iconUrl: z.string().nullable(),
          storeUrl: z.string().nullable(),
          dealId: z.number().nullable(),
          currency: z.string(),
          currentCents: z.number(),
          wasCents: z.number(),
          isDrop: z.boolean(),
          dropPct: z.number(),
          firstSnapshotDate: z.string(),
          lastCheckedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const watch = await db.select().from(schema.appWatch);
      const snaps = await db.select().from(schema.appPriceSnapshots);
      const dealRows = await db
        .select({ id: schema.deals.id, externalId: schema.deals.externalId })
        .from(schema.deals);
      const dealIdByExternal = new Map(dealRows.map((d) => [d.externalId, d.id]));
      const byTrack = new Map<number, typeof snaps>();
      for (const s of snaps) {
        const arr = byTrack.get(s.trackId) ?? [];
        arr.push(s);
        byTrack.set(s.trackId, arr);
      }
      const apps = [];
      for (const w of watch) {
        const list = (byTrack.get(w.trackId) ?? []).sort((a, b) => a.checkedAt - b.checkedAt);
        const latest = list[list.length - 1];
        if (!latest) continue;
        const wasCents = Math.max(...list.map((s) => s.priceCents));
        const isDrop = latest.priceCents < wasCents;
        apps.push({
          trackId: w.trackId,
          name: w.name,
          iconUrl: w.iconUrl ?? null,
          storeUrl: w.storeUrl ?? null,
          dealId: w.dealExternalId ? (dealIdByExternal.get(w.dealExternalId) ?? null) : null,
          currency: latest.currency,
          currentCents: latest.priceCents,
          wasCents,
          isDrop,
          dropPct: wasCents > 0 ? Math.round(((wasCents - latest.priceCents) / wasCents) * 100) : 0,
          firstSnapshotDate: list[0]?.snapshotDate ?? latest.snapshotDate,
          lastCheckedAt: new Date(latest.checkedAt).toISOString(),
        });
      }
      apps.sort((a, b) => Number(b.isDrop) - Number(a.isDrop) || b.dropPct - a.dropPct);
      return { apps };
    },
  }),

  /**
   * Search the WHOLE App Store catalogue, not just the deals this site has
   * collected. The APP page's search box used to filter only `deals` and
   * `app_price_snapshots`, so any app not on a current giveaway / price drop
   * simply showed three empty sections — with chip counts all reading 0,
   * which looked like the whole page had no data. This proxies Apple's
   * official iTunes Search API and marks results that we already track.
   */
  searchAppStore: defineAction({
    description: "Searches the full App Store catalogue via Apple's official iTunes Search API for a given storefront, and marks results this site already tracks as a free / in-app-purchase-free / price-drop item. Read-only and independent of the collected deals list.",
    request: z.object({
      query: z.string().trim().min(1).max(80),
      country: z.string().trim().min(2).max(5).optional(),
    }),
    response: z.object({
      country: z.string(),
      apps: z.array(
        z.object({
          trackId: z.number(),
          name: z.string(),
          iconUrl: z.string().nullable(),
          storeUrl: z.string().nullable(),
          sellerName: z.string().nullable(),
          genre: z.string().nullable(),
          price: z.number(),
          formattedPrice: z.string(),
          currency: z.string(),
          rating: z.number().nullable(),
          ratingCount: z.number().nullable(),
          collected: z.boolean(),
          tag: z.string().nullable(),
          dealId: z.number().nullable(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const country = APP_SEARCH_COUNTRIES.has(args.country ?? "cn") ? (args.country ?? "cn") : "cn";
      const term = args.query.trim().slice(0, 80);
      const cacheKey = `${country}:${term.toLowerCase()}`;
      const cached = appSearchCache.get(cacheKey);
      let rows: Record<string, unknown>[] = [];
      if (cached && Date.now() - cached.at < APP_SEARCH_TTL_MS) {
        rows = cached.rows;
      } else {
        try {
          const res = await fetch(
            `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${country}&entity=software&limit=25`,
            {
              headers: { "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(12_000),
            },
          );
          if (res.ok) {
            const data = (await res.json()) as Record<string, unknown>;
            rows = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
            appSearchCache.set(cacheKey, { at: Date.now(), rows });
            if (appSearchCache.size > 120) {
              for (const k of [...appSearchCache.keys()].slice(0, 40)) appSearchCache.delete(k);
            }
          }
        } catch {
          // Apple unreachable / timed out: return an empty full-catalogue
          // section but leave the collected-deals sections intact.
          rows = [];
        }
      }

      // Cross-reference against what this site already collected, by trackId.
      const dealRows = await db
        .select({ id: schema.deals.id, externalId: schema.deals.externalId, status: schema.deals.status })
        .from(schema.deals);
      const byTrack = new Map<number, { tag: string; dealId: number }>();
      for (const d of dealRows) {
        if (d.status !== "active" && d.status !== "upcoming") continue;
        const m = /^ios(free|iap)-(\d+)$/.exec(d.externalId);
        if (!m) continue;
        const tid = Number(m[2]);
        if (!Number.isFinite(tid)) continue;
        const tag = m[1] === "iap" ? "内购限免" : "本体限免";
        const prev = byTrack.get(tid);
        if (!prev || tag === "内购限免") byTrack.set(tid, { tag, dealId: d.id });
      }
      const watched = await db.select({ trackId: schema.appWatch.trackId }).from(schema.appWatch);
      const watchedIds = new Set(watched.map((w) => w.trackId));
      const snaps = await db
        .select({
          trackId: schema.appPriceSnapshots.trackId,
          priceCents: schema.appPriceSnapshots.priceCents,
          checkedAt: schema.appPriceSnapshots.checkedAt,
        })
        .from(schema.appPriceSnapshots);
      const grouped = new Map<number, { at: number; cents: number }[]>();
      for (const s of snaps) {
        const arr = grouped.get(s.trackId) ?? [];
        arr.push({ at: s.checkedAt, cents: s.priceCents });
        grouped.set(s.trackId, arr);
      }
      const dropIds = new Set<number>();
      for (const [tid, list] of grouped) {
        list.sort((a, b) => a.at - b.at);
        const latest = list[list.length - 1];
        const max = Math.max(...list.map((x) => x.cents));
        if (latest && latest.cents < max) dropIds.add(tid);
      }

      const apps = rows
        .filter((r) => typeof r.trackId === "number" && typeof r.trackName === "string" && r.wrapperType === "software")
        .map((r) => {
          const trackId = r.trackId as number;
          const hit = byTrack.get(trackId);
          const isDrop = dropIds.has(trackId);
          const art = typeof r.artworkUrl100 === "string" ? (r.artworkUrl100 as string) : null;
          return {
            trackId,
            name: String(r.trackName),
            iconUrl: art ? art.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/200x200bb.$1") : null,
            storeUrl: typeof r.trackViewUrl === "string" ? (r.trackViewUrl as string) : null,
            sellerName: typeof r.sellerName === "string" ? (r.sellerName as string) : null,
            genre: typeof r.primaryGenreName === "string" ? (r.primaryGenreName as string) : null,
            price: typeof r.price === "number" ? (r.price as number) : 0,
            formattedPrice: typeof r.formattedPrice === "string" ? (r.formattedPrice as string) : "免费",
            currency: typeof r.currency === "string" ? (r.currency as string) : "CNY",
            rating: typeof r.averageUserRating === "number" ? (r.averageUserRating as number) : null,
            ratingCount: typeof r.userRatingCount === "number" ? (r.userRatingCount as number) : null,
            collected: !!hit || isDrop || watchedIds.has(trackId),
            tag: hit?.tag ?? (isDrop ? "降价" : null),
            dealId: hit?.dealId ?? null,
          };
        })
        .slice(0, 25);
      return { country, apps };
    },
  }),

  appStoreRanking: defineAction({
    description: "Returns an official App Store chart for one storefront. Supports apps vs games, free vs paid charts, and any game sub-genre; data comes from Apple's iTunes RSS feed. Cached 10 minutes per combination.",
    request: z.object({
      country: z.string().trim().min(2).max(5).optional(),
      kind: z.enum(["apps", "games"]).optional(),
      chart: z.enum(["free", "paid"]).optional(),
      genre: z.number().int().positive().optional(),
      limit: z.number().int().min(10).max(100).optional(),
    }),
    response: z.object({
      country: z.string(),
      kind: z.enum(["apps", "games"]),
      chart: z.enum(["free", "paid"]),
      genre: z.number().nullable(),
      apps: z.array(rankingAppSchema),
      ok: z.boolean(),
    }),
    async handler(_ctx, args) {
      const country = APP_RANKING_COUNTRIES.has(args.country ?? "cn") ? (args.country ?? "cn") : "cn";
      const kind = args.kind === "games" ? "games" : "apps";
      const chart = args.chart === "paid" ? "paid" : "free";
      const limit = Math.min(100, Math.max(10, args.limit ?? 50));
      // Games default to the Games genre (6014); apps use the all-apps chart.
      const genre =
        kind === "games"
          ? args.genre && GAME_GENRE_IDS.has(args.genre)
            ? args.genre
            : 6014
          : args.genre && Number.isInteger(args.genre)
            ? args.genre
            : null;
      const cacheKey = `${country}:${kind}:${chart}:${genre ?? 0}:${limit}`;
      const empty = { country, kind, chart, genre, apps: [] as RankingAppOut[], ok: false };
      const cached = appRankingCache.get(cacheKey);
      if (cached && Date.now() - cached.at < APP_RANKING_TTL_MS) {
        return { country, kind, chart, genre, apps: cached.apps, ok: true };
      }
      const feed = chart === "free" ? "topfreeapplications" : "toppaidapplications";
      const genreSeg = genre ? `/genre=${genre}` : "";
      const url = `https://itunes.apple.com/${country}/rss/${feed}/limit=${limit}${genreSeg}/json`;
      let raw: Record<string, unknown>;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return empty;
        raw = (await res.json()) as Record<string, unknown>;
      } catch {
        // Apple unreachable: keep the last good chart rather than blanking.
        return cached ? { country, kind, chart, genre, apps: cached.apps, ok: true } : empty;
      }
      const feedObj = raw.feed && typeof raw.feed === "object" ? (raw.feed as Record<string, unknown>) : {};
      const entry = feedObj.entry;
      const list: Record<string, unknown>[] = Array.isArray(entry)
        ? (entry as Record<string, unknown>[])
        : entry && typeof entry === "object"
          ? [entry as Record<string, unknown>]
          : [];
      const rec = (v: unknown): Record<string, unknown> =>
        v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      const attrs = (v: unknown): Record<string, unknown> => rec(rec(v).attributes);
      const apps: RankingAppOut[] = [];
      for (const e of list) {
        const name = String(rec(e["im:name"]).label ?? "").trim();
        if (!name) continue;
        const imgs = Array.isArray(e["im:image"]) ? (e["im:image"] as Record<string, unknown>[]) : [];
        const iconRaw = String(rec(imgs[imgs.length - 1] ?? imgs[0]).label ?? "");
        const priceObj = rec(e["im:price"]);
        const priceAttrs = attrs(e["im:price"]);
        const catAttrs = attrs(e.category);
        apps.push({
          rank: apps.length + 1,
          trackId: Number(attrs(e.id)["im:id"] ?? 0),
          name,
          iconUrl: iconRaw ? iconRaw.replace(/\/\d+x\d+bb\./i, "/200x200bb.") : null,
          storeUrl: String(attrs(e.link).href ?? rec(e.id).label ?? "") || null,
          sellerName: String(rec(e["im:artist"]).label ?? "") || null,
          genre: String(catAttrs.label ?? "") || null,
          price: String(priceObj.label ?? ""),
          currency: String(priceAttrs.currency ?? ""),
          releaseDate: String(rec(e["im:releaseDate"]).label ?? "") || null,
        });
      }
      if (apps.length === 0) return empty;
      appRankingCache.set(cacheKey, { at: Date.now(), apps });
      if (appRankingCache.size > 120) {
        for (const k of [...appRankingCache.keys()].slice(0, 40)) appRankingCache.delete(k);
      }
      return { country, kind, chart, genre, apps, ok: true };
    },
  }),

  appleArcadeGames: defineAction({
    description: "Lists Apple Arcade games by aggregating Apple's official iTunes Search API across Arcade-related terms and keeping titles that have no standalone purchase price (Arcade titles are subscription-only). US storefront only: Apple Arcade is not available on the China mainland storefront. Cached 6 hours.",
    request: z.object({ country: z.string().trim().min(2).max(5).optional() }),
    response: z.object({
      country: z.string(),
      total: z.number(),
      games: z.array(arcadeGameSchema),
      ok: z.boolean(),
    }),
    async handler(_ctx, _args) {
      const country = "us";
      if (arcadeCache && Date.now() - arcadeCache.at < ARCADE_TTL_MS) {
        return { country, total: arcadeCache.games.length, games: arcadeCache.games, ok: true };
      }
      const settled = await Promise.allSettled(
        ARCADE_TERMS.map(async (term) => {
          const res = await fetch(
            `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=us&entity=software&limit=200`,
            { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) },
          );
          if (!res.ok) return [] as Record<string, unknown>[];
          const d = (await res.json()) as { results?: unknown };
          return Array.isArray(d.results) ? (d.results as Record<string, unknown>[]) : [];
        }),
      );
      const merged = new Map<number, Record<string, unknown>>();
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        for (const x of r.value) {
          const id = Number(x.trackId);
          if (Number.isFinite(id) && id > 0 && !merged.has(id)) merged.set(id, x);
        }
      }
      const games: ArcadeGameOut[] = [];
      for (const r of merged.values()) {
        const name = typeof r.trackName === "string" ? r.trackName.trim() : "";
        if (!name || name === "Apple Games") continue;
        const genreIds = Array.isArray(r.genreIds) ? r.genreIds.map(String) : [];
        const genres = Array.isArray(r.genres) ? r.genres.map(String) : [];
        if (!genreIds.includes("6014") && !genres.includes("Games")) continue;
        // Arcade titles cannot be bought individually: Apple omits both price
        // fields. Ordinary free apps return formattedPrice="Free" / price=0.
        if (r.formattedPrice !== undefined || r.price !== undefined) continue;
        const desc = typeof r.description === "string" ? r.description : "";
        let arcadeKind = "Arcade 原创";
        if (/\+\s*$/.test(name)) arcadeKind = "App Store Greats";
        else if (/apple arcade/i.test(desc) || /arcade edition/i.test(name)) arcadeKind = "Arcade 版";
        const art = typeof r.artworkUrl100 === "string" ? (r.artworkUrl100 as string) : "";
        games.push({
          trackId: Number(r.trackId),
          name,
          iconUrl: art ? art.replace(/\/\d+x\d+bb\./i, "/200x200bb.") : null,
          storeUrl: typeof r.trackViewUrl === "string" ? (r.trackViewUrl as string) : null,
          sellerName: typeof r.sellerName === "string" ? (r.sellerName as string) : null,
          genre: typeof r.primaryGenreName === "string" ? (r.primaryGenreName as string) : null,
          releaseDate: typeof r.releaseDate === "string" ? (r.releaseDate as string) : null,
          rating: typeof r.averageUserRating === "number" ? (r.averageUserRating as number) : null,
          arcadeKind,
        });
      }
      games.sort((a, b) => String(b.releaseDate ?? "").localeCompare(String(a.releaseDate ?? "")));
      if (games.length === 0) {
        return arcadeCache
          ? { country, total: arcadeCache.games.length, games: arcadeCache.games, ok: true }
          : { country, total: 0, games: [], ok: false };
      }
      arcadeCache = { at: Date.now(), games };
      return { country, total: games.length, games, ok: true };
    },
  }),

  getAccounts: defineAction({
    description: "Returns the binding status of the signed-in account's Epic, Steam and GOG accounts — display names, masked Steam API key tail, library sync counts and notes, plus for an unbound platform the server-recorded bind-attempt history (for Epic: timestamps, Epic's verbatim errors, one-way code fingerprints; for Steam: timestamps and the OpenID verification outcomes; for GOG: timestamps and GOG's verbatim token-endpoint errors) — plus the official login-popup URLs for Epic/GOG (the Steam OpenID login URL is assembled client-side because its return_to is this page's own address). Tokens are never returned. Signed out, it reads the legacy un-owned pool.",
    request: z.object({ ...authArg }),
    response: z.object({
      loginUrls: z.object({ epic: z.string(), gog: z.string() }),
      platforms: z.array(
        z.object({
          platform: z.enum(["epic", "steam", "gog"]),
          bound: z.boolean(),
          displayName: z.string().nullable(),
          accountRef: z.string().nullable(),
          hasApiKey: z.boolean(),
          apiKeyMasked: z.string().nullable(),
          syncCount: z.number(),
          lastSyncAt: z.string().nullable(),
          lastSyncNote: z.string().nullable(),
          // Epic / Steam only: the server-recorded outcome of the last bind
          // attempt (timestamp + the platform's verbatim error), so a failed
          // bind stays diagnosable from stored data instead of a transient
          // on-screen note. Null for GOG, when bound, or when no attempt has
          // been recorded yet.
          lastBindError: z.string().nullable(),
          // Epic / Steam only: the recent bind-attempt history (newest
          // first, up to 5), each line timestamped (Epic entries also carry
          // the submitted code's one-way fingerprint — this is what makes
          // “was the same code submitted twice?” answerable from stored
          // data). Empty elsewhere.
          bindAttempts: z.array(z.string()),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const items = await db.select().from(schema.libraryItems).where(eq(schema.libraryItems.userId, uid));
      const platforms = [];
      for (const p of ["epic", "steam", "gog"] as PlatformKey[]) {
        const row = await getAccountRow(ctx, uid, p);
        const syncCount = items.filter((i) => i.platform === p && i.source === "sync").length;
        const status = accountStatus(row, syncCount);
        let lastBindError: string | null = null;
        let bindAttempts: string[] = [];
        if (!status.bound) {
          const history = await readBindDiagHistory(ctx, uid, p);
          const latest = history[history.length - 1];
          if (latest && !latest.ok) {
            lastBindError = `上次绑定失败（${new Date(latest.at).toLocaleString("zh-CN", { hour12: false })}）：${latest.detail}`;
          }
          bindAttempts = history
            .slice(-5)
            .reverse()
            .map(
              (d) =>
                `${d.ok ? "成功" : "失败"} · ${new Date(d.at).toLocaleString("zh-CN", { hour12: false })} · ${d.detail}${d.fp ? ` · 码指纹 #${d.fp}` : ""}`,
            );
        }
        platforms.push({ platform: p, ...status, lastBindError, bindAttempts });
      }
      return { loginUrls: { epic: EPIC_POPUP_LOGIN_URL, gog: GOG_LOGIN_URL }, platforms };
    },
  }),

  epicLogin: defineAction({
    description: "Binds an Epic account to the signed-in account: extracts the authorization code from the pasted Epic login JSON (or a bare code / redirect URL), exchanges it at Epic's token endpoint with the launcher client using the Legendary-proven request shape (no redirect_uri; retries once with the launcher redirect_uri only when Epic's error names the redirect), stores the tokens server-side only under the account, then syncs the Epic game library. Every attempt is appended to a per-user bind-diagnostic history with a one-way fingerprint of the code (readable via getAccounts; never the code or tokens), and resubmitting a code whose fingerprint was already attempted is refused locally with the earlier attempt's recorded outcome instead of burning another Epic request. On failure the note carries Epic's own HTTP status, errorCode and message verbatim. The code normally arrives via the client's one-click clipboard completion; manual paste is the fallback.",
    request: z.object({ code: z.string().min(4).max(8000), ...authArg }),
    response: z.object({
      ok: z.boolean(),
      displayName: z.string().nullable(),
      count: z.number(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const uid = await ownerId(ctx, args.authToken);
      const code = extractAuthCode(args.code);
      if (!code) {
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, detail: "没有从提交内容里读到授权码（粘贴内容不完整或不是登录成功页的内容）" });
        return { ok: false, displayName: null, count: 0, note: "没有从粘贴内容里读到授权码：请在 Epic 登录成功页全选复制整段内容后，再点一次「完成绑定」" };
      }
      const fp = codeFingerprint(code);
      // Duplicate-submission guard. The client has two submit paths for the
      // SAME code (「完成绑定」 reads the clipboard; the paste box has its own
      // submit button), and production evidence (2026-11-07) shows two
      // attempts 57 seconds apart around one failure — an authorization code
      // can only ever be exchanged once, so a second submission of the same
      // code is guaranteed to draw `authorization_code_not_found` from Epic
      // and, worse, its failure record used to overwrite the first attempt's.
      // If this exact code was already attempted in the last 15 minutes,
      // answer from the recorded history instead of asking Epic again.
      const priorSameCode = (await readBindDiagHistory(ctx, uid))
        .filter((d) => d.fp === fp && Date.now() - d.at < 15 * 60000)
        .pop();
      if (priorSameCode) {
        const when = new Date(priorSameCode.at).toLocaleString("zh-CN", { hour12: false });
        await saveBindDiag(ctx, uid, {
          at: Date.now(),
          ok: false,
          fp,
          detail: `重复提交同一个授权码（码指纹 #${fp}），已拦截，未再请求 Epic；首次提交于 ${when}，结果：${priorSameCode.detail}`,
        });
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: `这个授权码已经在 ${when} 提交过一次了，结果是：${priorSameCode.detail}。同一个码只能提交一次，再提交 Epic 也只会回“码不存在”，所以这次没有再发给 Epic。请重新打开 Epic 登录页拿一个新码，拿到后只提交一次。`,
        };
      }
      // Stage 1: exchange the one-time code for tokens. The whole chain was
      // re-verified item-by-item against Legendary's current source
      // (legendary/api/egs.py, master, fetched 2026-11-07): same client_id
      // and secret, same prod03 token host, same login-URL construction,
      // same exchange body (grant_type + code + token_type=eg1, no
      // redirect_uri), same UELauncher User-Agent — no parameter differs
      // (full table in DATA-PLAN.md). Epic's device-code flow is NOT an
      // alternative for this client: live probes 2026-11-07 returned
      // 401 authentication_failed from /oauth/deviceAuthorization and
      // 400 unauthorized_client (“your client is not allowed to use the
      // grant type device_code”) from the token endpoint. Epic's raw error
      // is passed through verbatim so the real reason stays visible.
      // The request shape is the one every maintained client of this flow
      // (Legendary / Heroic) uses: grant_type + code + token_type=eg1 and
      // NO redirect_uri. Only if Epic's own error complains about the
      // redirect do we retry once WITH the launcher redirect_uri — a
      // redirect-mismatch rejection issues no token, so the code survives
      // that one retry.
      let data: Record<string, unknown> | null = null;
      let exchangeError: unknown = null;
      try {
        data = await epicTokenRequest({ grant_type: "authorization_code", code });
      } catch (e1) {
        if (e1 instanceof EpicOAuthError && /redirect/i.test(`${e1.errorCode ?? ""} ${e1.message}`)) {
          try {
            data = await epicTokenRequest({ grant_type: "authorization_code", code, redirect_uri: EPIC_REDIRECT_URI });
          } catch (e2) {
            exchangeError = e2;
          }
        } else {
          exchangeError = e1;
        }
      }
      if (!data) {
        const e = exchangeError;
        const raw = epicErrorText(e);
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, fp, detail: `换取令牌失败：${raw}` });
        if (e instanceof EpicOAuthError && e.errorCode === "errors.com.epicgames.oauth.corrective_action_required") {
          const cont =
            typeof e.data.continuationUrl === "string"
              ? e.data.continuationUrl
              : typeof e.data.correctiveAction === "string"
                ? e.data.correctiveAction
                : null;
          return {
            ok: false,
            displayName: null,
            count: 0,
            note: `Epic 要求先在官网完成一步额外操作（同意协议等）才能登录${cont ? `：${cont}` : ""}，完成后再重新打开登录页拿一个新码绑定。Epic 原始错误：${raw}`,
          };
        }
        if (
          e instanceof EpicOAuthError &&
          (e.errorCode === "errors.com.epicgames.account.oauth.authorization_code_not_found" ||
            /not found|no longer valid|expired/i.test(e.message))
        ) {
          return {
            ok: false,
            displayName: null,
            count: 0,
            note: `Epic 回复“授权码不存在”（authorization_code_not_found）：这个码在 Epic 那边查不到。已知会这样报错的情况包括：同一个码被重复提交（码是一次性的，提交过一次即作废）、或提交的不是最新拿到的那个码。面板下方的「服务端记录」列出了每次提交的时间和码指纹，可以对照是不是同一个码提交了两次。请重新打开 Epic 登录页拿一个新码，拿到后只提交一次。Epic 原始错误：${raw}`,
          };
        }
        return { ok: false, displayName: null, count: 0, note: `Epic 绑定失败，Epic 返回：${raw}` };
      }
      try {
        const accountId = typeof data.account_id === "string" ? data.account_id : null;
        if (!accountId) throw new Error("Epic 没有返回账号 ID");
        let displayName =
          typeof data.display_name === "string"
            ? data.display_name
            : typeof data.displayName === "string"
              ? data.displayName
              : null;
        if (!displayName) {
          try {
            const ares = await fetch(
              `https://account-public-service-prod03.ol.epicgames.com/account/api/public/account/${accountId}`,
              { headers: { Authorization: `Bearer ${data.access_token as string}` } },
            );
            if (ares.ok) {
              const adata = (await ares.json()) as Record<string, unknown>;
              if (typeof adata.displayName === "string") displayName = adata.displayName;
            }
          } catch {
            // display name optional
          }
        }
        await saveAccountRow(ctx, uid, "epic", {
          displayName,
          accountRef: accountId,
          accessToken: data.access_token as string,
          refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
          expiresAt: typeof data.expires_at === "string" ? new Date(data.expires_at).getTime() : Date.now() + 8 * 3600000,
          lastSyncNote: null,
        });
        // Stage 2: first library sync. The binding itself is already saved
        // at this point, so a sync failure must NOT be reported as a binding
        // failure (the code is consumed either way; telling the user the
        // login failed invites a retry with a now-dead code).
        try {
          const sync = await syncEpicLibrary(ctx, uid);
          await saveBindDiag(ctx, uid, { at: Date.now(), ok: true, fp, detail: `绑定成功：${sync.note}` });
          ctx.invalidateQueries();
          return { ok: true, displayName, count: sync.count, note: sync.note };
        } catch (se) {
          const note = `Epic 已绑定成功，但首次同步游戏库失败（${epicErrorText(se)}），稍后点「同步」重试即可`;
          await saveBindDiag(ctx, uid, { at: Date.now(), ok: true, fp, detail: note });
          ctx.invalidateQueries();
          return {
            ok: true,
            displayName,
            count: 0,
            note,
          };
        }
      } catch (e) {
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, fp, detail: `令牌已换到，但保存绑定失败：${epicErrorText(e)}` });
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: `Epic 绑定失败：${epicErrorText(e)}`,
        };
      }
    },
  }),

  gogLogin: defineAction({
    description: "Binds a GOG account to the signed-in account: exchanges the one-time authorization code from GOG's official auth popup flow for tokens, stores them server-side only, then syncs the owned-games library from embed.gog.com. The submitted content may be the bare code, the full on_login_success success-page URL (the code is parsed out of its code= parameter — that page renders blank white by design), or the page JSON. Every attempt is appended to the per-user GOG bind-diagnostic history (readable via getAccounts), and token failures carry GOG's own HTTP status and error code verbatim. The code normally arrives via the client's one-click clipboard completion; manual paste is the fallback.",
    request: z.object({ code: z.string().min(4).max(8000), ...authArg }),
    response: z.object({
      ok: z.boolean(),
      displayName: z.string().nullable(),
      count: z.number(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const uid = await ownerId(ctx, args.authToken);
      try {
        const code = extractAuthCode(args.code);
        if (!code) {
          await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, detail: "没有从提交内容里读到授权码（粘贴内容不完整，或不是 GOG 登录成功页地址栏的链接）" }, "gog");
          return { ok: false, displayName: null, count: 0, note: "没有读到授权码：请复制 GOG 登录成功页（白屏页）地址栏里的整条链接后，再点一次「完成绑定」" };
        }
        const data = await gogTokenRequest({ grant_type: "authorization_code", code });
        const userId = typeof data.user_id === "string" ? data.user_id : null;
        const token = data.access_token as string;
        let displayName: string | null = null;
        try {
          const ures = await fetch("https://embed.gog.com/userdata.json", {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" },
          });
          if (ures.ok) {
            const udata = (await ures.json()) as Record<string, unknown>;
            if (typeof udata.username === "string") displayName = udata.username;
          }
        } catch {
          // display name optional
        }
        await saveAccountRow(ctx, uid, "gog", {
          displayName,
          accountRef: userId,
          accessToken: token,
          refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
          expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 3600000),
          lastSyncNote: null,
        });
        const sync = await syncGogLibrary(ctx, uid);
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: true, detail: `绑定成功：${sync.note}` }, "gog");
        ctx.invalidateQueries();
        return { ok: true, displayName, count: sync.count, note: sync.note };
      } catch (e) {
        // GOG's raw error (HTTP status + error code from the token
        // endpoint) goes into the diagnostic history AND the note — never
        // a bare “失败”.
        const raw = e instanceof Error ? e.message : String(e);
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, detail: `换取令牌失败：${raw}` }, "gog");
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: `GOG 绑定失败：${raw}`,
        };
      }
    },
  }),

  steamOpenIdStart: defineAction({
    description: "Issues a one-time, 15-minute Steam OpenID bind ticket for the signed-in account (stored server-side in meta). The client embeds the ticket in the OpenID return_to URL it opens on steamcommunity.com, so when Steam redirects back to this artifact's own page, steamOpenIdVerify can attribute the binding to the right account from the ticket alone — no session cookie needs to survive the popup.",
    request: z.object({ ...authArg }),
    response: z.object({ ticket: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const ticket = randomHex(32);
      await db.insert(schema.meta).values({
        key: `steam_openid_ticket_${ticket}`,
        value: JSON.stringify({ userId: uid, exp: Date.now() + STEAM_TICKET_TTL_MS }),
      });
      return { ticket };
    },
  }),

  steamOpenIdVerify: defineAction({
    description: "Completes a Steam binding from the official OpenID login: takes the openid.* assertion params Steam appended to the return URL on this artifact's own page (plus the one-time ticket steamOpenIdStart embedded in that URL), relays them to Steam's check_authentication endpoint, and only on Steam's own is_valid:true verdict binds the claimed SteamID64 to the ticket's account (falling back to the session token's account). The persona name comes from Steam's public profile XML (no API key needed). Any previously saved Steam Web API key is preserved; with a key, the library sync runs immediately, without one the binding still succeeds and only the sync waits for the optional key. Every attempt is appended to the per-user Steam bind-diagnostic history surfaced by getAccounts.",
    request: z.object({
      params: z.record(z.string(), z.string()),
      ticket: z.string().min(16).max(128).optional(),
      ...authArg,
    }),
    response: z.object({
      ok: z.boolean(),
      displayName: z.string().nullable(),
      count: z.number(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      // The ticket (single-use, embedded in the return URL by
      // steamOpenIdStart) is the primary identity: the returned page may
      // live in a different browser context than the app, with no session.
      let uid: number | null = null;
      if (args.ticket) uid = await consumeSteamBindTicket(ctx, args.ticket);
      if (uid === null) {
        const sessionUid = await resolveUserId(ctx, args.authToken);
        if (sessionUid !== null) uid = sessionUid;
      }
      if (uid === null) {
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: "这次跳回的绑定凭证已过期或已被使用：请回到空间的 Steam 绑定面板，重新点一次「打开 Steam 官方登录页」再登录。",
        };
      }
      const p = args.params;
      const claimedId = typeof p["openid.claimed_id"] === "string" ? p["openid.claimed_id"] : "";
      const idMatch = claimedId.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{15,20})$/);
      if (p["openid.mode"] !== "id_res" || !idMatch || !idMatch[1]) {
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, detail: "跳回参数不完整：没有读到 Steam 的有效登录断言（openid.mode / claimed_id 缺失或不对）" }, "steam");
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: "跳回参数不完整：没有读到 Steam 的登录断言。请回到绑定面板重新打开 Steam 官方登录页再登录一次。",
        };
      }
      const steamId = idMatch[1];
      let verdict: { valid: boolean; raw: string };
      try {
        verdict = await checkSteamAssertion(p);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // steamcommunity.com 在部分网络（含国内）整站不可达。这种情况下
        // 让用户「稍后重试」是没用的，必须直接给出可执行的替代路径。
        const unreachable = /abort|timeout|timed out|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(reason);
        const detail = unreachable
          ? "服务器连不上 steamcommunity.com（Steam 的登录/校验域名在当前网络下不可达）"
          : `向 Steam 核验时网络失败：${reason}`;
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: false, detail }, "steam");
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: unreachable
            ? "Steam 官方登录当前不可用：服务器访问不了 steamcommunity.com。请改用「SteamID 绑定」——填 17 位 SteamID64 即可，不需要打开 Steam 网页。"
            : `Steam 绑定失败：${detail}，请稍后重试。`,
        };
      }
      if (!verdict.valid) {
        await saveBindDiag(
          ctx,
          uid,
          { at: Date.now(), ok: false, detail: `Steam 核验未通过：check_authentication 返回 is_valid:false（跳回参数无效或已过期）` },
          "steam",
        );
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: "Steam 核验未通过：Steam 对这组跳回参数的签名核验返回 is_valid:false，说明参数无效或已经过期。请回到绑定面板重新登录一次。",
        };
      }
      // Steam itself verified the assertion: bind. An API key saved earlier
      // (old form flow) is preserved — saveAccountRow patches only the
      // fields passed, and steamApiKey is not among them.
      const displayName = await fetchSteamPersonaName(steamId);
      await saveAccountRow(ctx, uid, "steam", {
        displayName,
        accountRef: steamId,
        accessToken: null,
        refreshToken: null,
        lastSyncNote: null,
      });
      try {
        const sync = await syncSteamLibrary(ctx, uid);
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: true, detail: `官方登录绑定成功（${displayName ?? steamId}）：${sync.note}` }, "steam");
        ctx.invalidateQueries();
        return { ok: true, displayName, count: sync.count, note: `已通过 Steam 官方登录绑定成功。${sync.note}` };
      } catch (se) {
        const note = `Steam 已绑定成功，但首次同步游戏库失败（${se instanceof Error ? se.message : String(se)}），稍后点「同步」重试即可`;
        await saveBindDiag(ctx, uid, { at: Date.now(), ok: true, detail: note }, "steam");
        ctx.invalidateQueries();
        return { ok: true, displayName, count: 0, note };
      }
    },
  }),

  steamBind: defineAction({
    description: "Legacy/manual Steam path, now secondary to the official OpenID login (steamOpenIdVerify): binds by SteamID64 plus the user's own Steam Web API key, or — when the account is already bound — saves/replaces the API key on the existing binding so the library can sync. The key is stored server-side only and only its last 4 characters are ever shown again. Syncs the owned-games library via the official Web API when a key is present.",
    request: z.object({
      steamId: z.string().min(3).max(64),
      apiKey: z.string().max(64).optional(),
      ...authArg,
    }),
    response: z.object({
      ok: z.boolean(),
      displayName: z.string().nullable(),
      count: z.number(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      try {
        let steamId = args.steamId.trim();
        const profileMatch = steamId.match(/profiles\/(\d{10,})/);
        if (profileMatch && profileMatch[1]) steamId = profileMatch[1];
        if (!/^\d{15,20}$/.test(steamId)) {
          if (!args.apiKey) {
            return { ok: false, displayName: null, count: 0, note: "这看起来是自定义 URL 名而不是 SteamID64；填入 API Key 后可以自动解析，或直接填 17 位 SteamID64" };
          }
          const vres = await fetch(
            `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(args.apiKey)}&vanityurl=${encodeURIComponent(steamId.replace(/^id\//, ""))}`,
          );
          const vdata = (await vres.json().catch(() => ({}))) as Record<string, unknown>;
          const resp = (vdata.response ?? {}) as Record<string, unknown>;
          if (resp.success !== 1 || typeof resp.steamid !== "string") {
            return { ok: false, displayName: null, count: 0, note: "无法把这个自定义 URL 解析成 SteamID，请改填 17 位 SteamID64" };
          }
          steamId = resp.steamid;
        }
        const uid = await ownerId(ctx, args.authToken);
        const existing = await getAccountRow(ctx, uid, "steam");
        await saveAccountRow(ctx, uid, "steam", {
          accountRef: steamId,
          accessToken: null,
          refreshToken: null,
          steamApiKey: args.apiKey?.trim() ? args.apiKey.trim() : (existing?.steamApiKey ?? null),
        });
        const sync = await syncSteamLibrary(ctx, uid);
        const row = await getAccountRow(ctx, uid, "steam");
        ctx.invalidateQueries();
        return { ok: true, displayName: row?.displayName ?? null, count: sync.count, note: sync.note };
      } catch (e) {
        return {
          ok: false,
          displayName: null,
          count: 0,
          note: `Steam 绑定失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  }),

  syncPlatformLibrary: defineAction({
    description: "Re-syncs the game library of one platform (Epic / Steam / GOG) bound to the signed-in account, using the stored server-side token or Steam API key, and reports how many games were synced or why it could not.",
    request: z.object({ platform: z.enum(["epic", "steam", "gog"]), ...authArg }),
    response: z.object({ ok: z.boolean(), count: z.number(), note: z.string() }),
    async handler(ctx, args) {
      const uid = await ownerId(ctx, args.authToken);
      try {
        const r = await syncPlatform(ctx, uid, args.platform);
        ctx.invalidateQueries();
        return { ok: true, count: r.count, note: r.note };
      } catch (e) {
        const note = `同步失败：${e instanceof Error ? e.message : String(e)}`;
        await saveAccountRow(ctx, uid, args.platform, { lastSyncAt: Date.now(), lastSyncNote: note });
        ctx.invalidateQueries();
        return { ok: false, count: 0, note };
      }
    },
  }),

  syncAllPlatformLibraries: defineAction({
    description: "Syncs the game libraries of ALL bound platforms (Epic, Steam, GOG) for the signed-in account in one tap. Runs the three platforms concurrently, caps each at 30s so one unreachable API cannot stall the rest, skips unbound platforms, records per-platform lastSyncNote, and returns a compact per-platform result.",
    request: z.object({ ...authArg }),
    response: z.object({
      ok: z.boolean(),
      bound: z.number(),
      synced: z.number(),
      results: z.array(
        z.object({
          platform: z.enum(["epic", "steam", "gog"]),
          bound: z.boolean(),
          ok: z.boolean(),
          count: z.number(),
          note: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const uid = await ownerId(ctx, args.authToken);
      const platforms: PlatformKey[] = ["epic", "steam", "gog"];
      const bindings = await Promise.all(
        platforms.map(async (p) => {
          const row = await getAccountRow(ctx, uid, p);
          return { platform: p, bound: !!(row && (row.accountRef || row.accessToken)) };
        }),
      );
      const results = await Promise.all(
        bindings.map(async ({ platform, bound }) => {
          if (!bound) {
            return { platform, bound: false, ok: true, count: 0, note: "未绑定，已跳过" };
          }
          try {
            const r = await withTimeout(syncPlatform(ctx, uid, platform), 30_000, `${PLATFORM_LABEL[platform]} 接口`);
            await saveAccountRow(ctx, uid, platform, { lastSyncAt: Date.now(), lastSyncNote: r.note });
            return { platform, bound: true, ok: true, count: r.count, note: r.note };
          } catch (e) {
            const note = `同步失败：${e instanceof Error ? e.message : String(e)}`;
            try {
              await saveAccountRow(ctx, uid, platform, { lastSyncAt: Date.now(), lastSyncNote: note });
            } catch {
              // best effort — the sync result is still reported
            }
            return { platform, bound: true, ok: false, count: 0, note };
          }
        }),
      );
      ctx.invalidateQueries();
      const bound = results.filter((r) => r.bound).length;
      return {
        ok: results.every((r) => r.ok),
        bound,
        synced: results.filter((r) => r.bound && r.ok).length,
        results,
      };
    },
  }),

  backfillEpicAcquiredAt: defineAction({
    description: "One-time maintenance: for every in-app account with an Epic binding, re-runs the (now incremental) Epic library sync so each stored game row gains Epic's own acquisitionDate as its acquired_at — repairing libraries whose rows all showed the original sync day as their 入库时间. Idempotent: the sync merges in place and never moves an existing row's first-sync time. Returns per-account counts plus sample titles with their real acquisition dates.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      accounts: z.number(),
      updated: z.number(),
      withDate: z.number(),
      samples: z.array(z.object({ title: z.string(), acquiredAt: z.string() })),
      note: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const epicAccounts = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.platform, "epic"), ne(schema.accounts.userId, 0)));
      let updated = 0;
      const notes: string[] = [];
      for (const acc of epicAccounts) {
        try {
          const r = await syncEpicLibrary(ctx, acc.userId);
          updated += r.count;
          notes.push(`用户 ${acc.userId}：${r.note}`);
        } catch (e) {
          notes.push(`用户 ${acc.userId}：回填失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Sample AFTER the syncs: games with a platform acquisition date,
      // oldest first — proof the dates are Epic's, not the sync day.
      const dated = await db
        .select()
        .from(schema.libraryItems)
        .where(and(eq(schema.libraryItems.platform, "epic"), isNotNull(schema.libraryItems.acquiredAt)))
        .orderBy(asc(schema.libraryItems.acquiredAt))
        .limit(5000);
      const samples: { title: string; acquiredAt: string }[] = [];
      const seenTitles = new Set<string>();
      for (const r of dated) {
        if (samples.length >= 6) break;
        if (seenTitles.has(r.title)) continue;
        seenTitles.add(r.title);
        if (r.acquiredAt) samples.push({ title: r.title, acquiredAt: new Date(r.acquiredAt).toISOString() });
      }
      ctx.invalidateQueries();
      return {
        ok: true as const,
        accounts: epicAccounts.length,
        updated,
        withDate: dated.length,
        samples,
        note: notes.join("；") || "没有已绑定的 Epic 账号",
      };
    },
  }),

  unbindPlatform: defineAction({
    description: "Unbinds one platform account from the signed-in account: deletes its server-side tokens/keys and its synced library rows. Manually added games and in-app claimed marks are kept.",
    request: z.object({ platform: z.enum(["epic", "steam", "gog"]), ...authArg }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      await db
        .delete(schema.accounts)
        .where(and(eq(schema.accounts.userId, uid), eq(schema.accounts.platform, args.platform)));
      await db
        .delete(schema.libraryItems)
        .where(
          and(
            eq(schema.libraryItems.userId, uid),
            eq(schema.libraryItems.platform, args.platform),
            eq(schema.libraryItems.source, "sync"),
          ),
        );
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listLibrary: defineAction({
    description: "Returns the signed-in account's game library grouped by channel: Epic / Steam / GOG groups hold games synced from the bound account, games claimed in this app on that platform, and previously added manual games; claimed Prime Gaming games are filed under their redemption channel, with extra Amazon Games App and Legacy Games groups when such games exist. Entries are deduplicated per platform by normalized title across sources: when the same game exists both as a claimed deal and as a synced library row, only the synced entry is returned (with the earlier of the two acquisition dates), so group counts never double-count a game. Each entry also carries its playtime freshness (playtimeUpdatedAt), when it entered the library (addedAt), and an official store link built only from identifiers captured at sync time (Steam appid, Epic/GOG product slug) with the platform's own store search as the labelled fallback. The response also returns the account's remembered library view/sort preferences and each platform's playtime-sync support status from the last real attempt.",
    request: z.object({ ...authArg }),
    response: z.object({
      groups: z.array(
        z.object({
          platform: z.enum(["epic", "steam", "gog", "amazon", "legacy"]),
          entries: z.array(
            z.object({
              key: z.string(),
              title: z.string(),
              imageUrl: z.string().nullable(),
              playtimeMinutes: z.number().nullable(),
              playtimeUpdatedAt: z.string().nullable(),
              addedAt: z.string().nullable(),
              // What addedAt MEANS for this entry: "platform" = the
              // platform's own acquisition date (Epic acquisitionDate);
              // "first-sync" = the row's first-sync time, preserved
              // across re-syncs (Steam/GOG report no acquisition date);
              // "claimed" = when the user marked the deal claimed here.
              addedAtKind: z.enum(["platform", "first-sync", "claimed"]),
              storeUrl: z.string().nullable(),
              origin: z.enum(["sync", "claimed", "manual"]),
              itemId: z.number().nullable(),
              dealId: z.number().nullable(),
              // Epic synced rows only: device platforms from the Epic
              // catalog evidence stored at sync ("pc" / "mobile" /
              // both). Empty for Steam/GOG, claimed and manual entries
              // — the UI renders the mark only for Epic sync rows.
              devicePlatforms: z.array(z.enum(["pc", "mobile"])),
            }),
          ),
        }),
      ),
      prefs: z.object({
        view: z.enum(["list", "grid", "compact"]),
        sort: z.enum(["default", "playtime", "name", "recent"]),
        // Platform groups the account keeps folded on the Mine page
        // (group keys: epic / steam / gog / amazon / legacy). Default
        // is empty = everything expanded.
        folded: z.array(z.string()),
      }),
      playtimeStatus: z.array(
        z.object({
          platform: z.enum(["epic", "steam", "gog"]),
          state: z.enum(["ok", "unsupported", "unknown"]),
          note: z.string().nullable(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const items = await db
        .select()
        .from(schema.libraryItems)
        .where(eq(schema.libraryItems.userId, uid))
        // Insertion order, NOT title order: the client's 默认排序 must be
        // distinguishable from 按名称, which sorts by title itself.
        .orderBy(asc(schema.libraryItems.id));
      const claimedRows = await db
        .select()
        .from(schema.marks)
        .where(and(eq(schema.marks.kind, "claimed"), eq(schema.marks.userId, uid)));
      const claimedIds = new Set(claimedRows.map((m) => m.dealId));
      const dealRows = await db.select().from(schema.deals);
      type LibGroup = "epic" | "steam" | "gog" | "amazon" | "legacy";
      type LibEntry = {
        key: string;
        title: string;
        imageUrl: string | null;
        playtimeMinutes: number | null;
        playtimeUpdatedAt: string | null;
        addedAt: string | null;
        addedAtKind: "platform" | "first-sync" | "claimed";
        storeUrl: string | null;
        origin: "sync" | "claimed" | "manual";
        itemId: number | null;
        dealId: number | null;
        devicePlatforms: ("pc" | "mobile")[];
      };
      // Official store links are built ONLY from identifiers captured at
      // sync time. Steam: the appid IS the extKey → the canonical app
      // page. Epic/GOG: the product slug captured at sync → the product
      // page; without a slug the platform's own store search for the
      // game's exact name is the fallback (never an invented product URL).
      const storeUrlFor = (platform: LibGroup, title: string, extKey: string | null, slug: string | null): string | null => {
        const cleanTitle = title.replace(/[《》]/g, "").trim();
        if (platform === "steam") {
          if (extKey && /^\d+$/.test(extKey)) return `https://store.steampowered.com/app/${extKey}`;
          return `https://store.steampowered.com/search/?term=${encodeURIComponent(cleanTitle)}`;
        }
        if (platform === "epic") {
          if (slug) return `https://store.epicgames.com/p/${encodeURIComponent(slug)}`;
          return `https://store.epicgames.com/browse?q=${encodeURIComponent(cleanTitle)}`;
        }
        if (platform === "gog") {
          if (slug) return `https://www.gog.com/game/${encodeURIComponent(slug)}`;
          return `https://www.gog.com/games?query=${encodeURIComponent(cleanTitle)}`;
        }
        return null;
      };
      const byGroup = new Map<LibGroup, LibEntry[]>([
        ["epic", []],
        ["steam", []],
        ["gog", []],
        ["amazon", []],
        ["legacy", []],
      ]);
      for (const it of items) {
        byGroup.get(it.platform)?.push({
          key: `item-${it.id}`,
          title: it.title,
          imageUrl: normalizeLibraryCover(it.platform, it.imageUrl ?? null, it.extKey ?? null),
          playtimeMinutes: it.playtimeMinutes ?? null,
          playtimeUpdatedAt: it.playtimeUpdatedAt ? new Date(it.playtimeUpdatedAt).toISOString() : null,
          // The platform's own acquisition date when it reports one
          // (Epic); otherwise the row's created_at, which incremental
          // sync preserves as the true first-sync time.
          addedAt: it.acquiredAt
            ? new Date(it.acquiredAt).toISOString()
            : it.createdAt
              ? it.createdAt.toISOString()
              : null,
          addedAtKind: it.acquiredAt ? "platform" : "first-sync",
          storeUrl: storeUrlFor(it.platform, it.title, it.extKey, it.storeSlug ?? null),
          origin: it.source,
          itemId: it.id,
          dealId: null,
          devicePlatforms:
            it.platform === "epic"
              ? (it.devicePlatforms ?? "")
                  .split(",")
                  .filter((p): p is "pc" | "mobile" => p === "pc" || p === "mobile")
              : [],
        });
      }
      const claimedAtByDeal = new Map<number, string>();
      for (const m of claimedRows) {
        if (m.createdAt) claimedAtByDeal.set(m.dealId, m.createdAt.toISOString());
      }
      // Cross-source dedupe index: platform + normalized title → the
      // synced/manual entry for that game. A game the user both claimed
      // here AND owns on the platform (synced) must appear ONCE — the
      // synced entry wins (its portrait cover and metadata), with the
      // earlier of the two入库 dates. Keys are collected from every
      // title form (sync title, deal title, deal Chinese title) because
      // the same game is named slightly differently per source.
      const syncIndex = new Map<LibGroup, Map<string, LibEntry>>();
      for (const platform of ["epic", "steam", "gog"] as LibGroup[]) {
        const m = new Map<string, LibEntry>();
        for (const e of byGroup.get(platform) ?? []) {
          const k = normName(baseTitle(e.title));
          if (k && !m.has(k)) m.set(k, e);
        }
        syncIndex.set(platform, m);
      }
      // "Game: Some Pack Giveaway" → the base game's normalized key: a
      // claimed DLC / pack belongs to its base game, it is not a second
      // library entry for it.
      const headKey = (t: string): string => normName(baseTitle(t).split(/[:：]/)[0] ?? "");
      type ClaimedCand = {
        d: (typeof dealRows)[number];
        group: LibGroup;
        isDlc: boolean;
        claimedTitle: string;
        keys: string[];
      };
      const cands: ClaimedCand[] = [];
      for (const d of dealRows) {
        if (!claimedIds.has(d.id)) continue;
        const tags = d.tags.split(",");
        if (!tags.includes("game") && !tags.includes("dlc")) continue;
        // Prime member games file under their redemption channel; other
        // claimed deals under their store bucket. Multi-channel groups keep
        // "other" out entirely rather than guessing.
        let group: LibGroup | null = null;
        if (d.externalId.startsWith("prime-")) {
          const ch = primeChannelOf(d.platform);
          group = ch === "other" ? null : ch;
        } else {
          const gp = classifyGamePlatform(d);
          group = gp === "epic" || gp === "steam" || gp === "gog" ? gp : null;
        }
        if (!group) continue;
        const claimedTitle = d.titleZh?.trim() || d.title;
        // Every normalized title form this deal answers to.
        const keys = [
          ...new Set(
            [d.title, claimedTitle, d.titleZh ?? ""]
              .map((t) => normName(baseTitle(t)))
              .filter((k) => k.length > 0),
          ),
        ];
        cands.push({ d, group, isDlc: tags.includes("dlc") && !tags.includes("game"), claimedTitle, keys });
      }
      // Entries actually pushed as claimed cards, indexed by every title
      // form, so a later claim for the same game (any source) folds in.
      const claimedIndex = new Map<LibGroup, Map<string, LibEntry>>();
      const claimedSeen = new Map<LibGroup, Set<string>>();
      const foldClaimDate = (target: LibEntry, dealId: number) => {
        const claimedAt = claimedAtByDeal.get(dealId) ?? null;
        if (claimedAt && (!target.addedAt || claimedAt < target.addedAt)) {
          target.addedAt = claimedAt;
          target.addedAtKind = "claimed";
        }
      };
      const placeClaimed = (c: ClaimedCand, extraKeys: string[]) => {
        const { d, group, claimedTitle } = c;
        const keys = [...new Set([...c.keys, ...extraKeys])];
        const seen = claimedSeen.get(group) ?? new Set<string>();
        claimedSeen.set(group, seen);
        // Same game already in the library from a platform sync: fold
        // this claim into that entry instead of adding a second card.
        // The merged entry keeps the sync cover/metadata; its入库 date
        // becomes the earlier of the platform date and the claim date.
        const syncEntry = keys.map((k) => syncIndex.get(group)?.get(k)).find((e) => e != null);
        if (syncEntry) {
          foldClaimDate(syncEntry, d.id);
          for (const k of keys) seen.add(k);
          return;
        }
        // Same game already pushed as a claimed card (the same game
        // often exists as both an Epic-feed row and a GamerPower row,
        // and a DLC claim folds into its base game's card): keep one.
        const idx = claimedIndex.get(group) ?? new Map<string, LibEntry>();
        claimedIndex.set(group, idx);
        const claimedEntry = keys.map((k) => idx.get(k)).find((e) => e != null);
        if (claimedEntry) {
          foldClaimDate(claimedEntry, d.id);
          for (const k of keys) seen.add(k);
          return;
        }
        if (keys.some((k) => seen.has(k))) return;
        for (const k of keys) seen.add(k);
        const entry: LibEntry = {
          key: `deal-${d.id}`,
          title: claimedTitle,
          imageUrl: d.imageUrl ?? null,
          playtimeMinutes: null,
          playtimeUpdatedAt: null,
          addedAt: claimedAtByDeal.get(d.id) ?? null,
          addedAtKind: "claimed",
          storeUrl: storeUrlFor(group, claimedTitle, null, null),
          origin: "claimed",
          itemId: null,
          dealId: d.id,
          devicePlatforms: [],
        };
        byGroup.get(group)?.push(entry);
        for (const k of keys) idx.set(k, entry);
      };
      // Base games first, so a DLC claim processed afterwards finds its
      // base game's card (sync or claimed) to fold into. Among claims
      // for the same game, official-feed rows (Epic feed) are placed
      // before GamerPower rows so the surviving card carries the
      // official cover and clean title; folded claims still contribute
      // their (earlier) claim date via foldClaimDate.
      const baseCands = cands
        .filter((c) => !c.isDlc)
        .sort(
          (a, b) =>
            (a.d.externalId.startsWith("gp-") ? 1 : 0) - (b.d.externalId.startsWith("gp-") ? 1 : 0),
        );
      for (const c of baseCands) placeClaimed(c, []);
      for (const c of cands) {
        if (!c.isDlc) continue;
        const heads = [headKey(c.d.title), headKey(c.claimedTitle), headKey(c.d.titleZh ?? "")].filter(
          (k) => k.length > 0 && !c.keys.includes(k),
        );
        placeClaimed(c, heads);
      }
      const groups = (["epic", "steam", "gog", "amazon", "legacy"] as LibGroup[])
        .map((platform) => {
          // No re-sorting here: entries keep insertion order (synced rows
          // by row id, then claimed deals), which is the client's 默认
          // order. Every other order is applied by the client from the
          // user's sort choice — re-sorting by title here is what made
          // 名称排序 indistinguishable from 默认.
          const entries = byGroup.get(platform) ?? [];
          return { platform, entries };
        })
        // Amazon / Legacy groups only exist as Prime redemption channels:
        // show them once a claimed Prime game actually lands there.
        .filter((g) => (g.platform === "amazon" || g.platform === "legacy" ? g.entries.length > 0 : true));
      // Library view/sort preferences are remembered per account (meta,
      // keyed by owner id — the legacy pool is owner 0).
      let prefs = { view: "list" as "list" | "grid" | "compact", sort: "default" as "default" | "playtime" | "name" | "recent", folded: [] as string[] };
      const prefRows = await db.select().from(schema.meta).where(eq(schema.meta.key, `lib_prefs_${uid}`));
      try {
        const raw = prefRows[0]?.value ? (JSON.parse(prefRows[0].value) as Record<string, unknown>) : {};
        if (raw.view === "grid" || raw.view === "compact" || raw.view === "list") prefs.view = raw.view;
        if (raw.sort === "playtime" || raw.sort === "name" || raw.sort === "recent" || raw.sort === "default") prefs.sort = raw.sort;
        if (Array.isArray(raw.folded)) {
          prefs.folded = raw.folded.filter(
            (g): g is string => typeof g === "string" && ["epic", "steam", "gog", "amazon", "legacy"].includes(g),
          );
        }
      } catch {
        // keep defaults
      }
      const statusMap = await readPlaytimeStatus(ctx, uid);
      const playtimeStatus = (["epic", "steam", "gog"] as PlatformKey[]).map((p) => ({
        platform: p,
        state: (statusMap[p]?.state ?? "unknown") as "ok" | "unsupported" | "unknown",
        note: statusMap[p]?.note ?? null,
      }));
      return { groups, prefs, playtimeStatus };
    },
  }),

  saveLibraryPrefs: defineAction({
    description: "Remembers the signed-in account's game-library view mode (list / grid / compact), sort order (default / playtime / name / recent) and folded platform groups server-side, so the choices are restored on the next visit and on other devices. Omitted fields keep their stored values.",
    request: z.object({
      view: z.enum(["list", "grid", "compact"]),
      sort: z.enum(["default", "playtime", "name", "recent"]),
      folded: z.array(z.enum(["epic", "steam", "gog", "amazon", "legacy"])).optional(),
      ...authArg,
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const key = `lib_prefs_${uid}`;
      const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
      // Merge into the stored prefs so a caller that only knows some of
      // the fields never wipes the others.
      let stored: Record<string, unknown> = {};
      try {
        stored = rows[0]?.value ? (JSON.parse(rows[0].value) as Record<string, unknown>) : {};
      } catch {
        stored = {};
      }
      const value = JSON.stringify({
        view: args.view,
        sort: args.sort,
        folded: args.folded ?? (Array.isArray(stored.folded) ? stored.folded : []),
      });
      if (rows[0]) await db.update(schema.meta).set({ value }).where(eq(schema.meta.key, key));
      else await db.insert(schema.meta).values({ key, value });
      return { ok: true as const };
    },
  }),

  getLibraryGameDetail: defineAction({
    description: "Returns the substantive store content for one library game — official intro text, screenshots, genres, developer, publisher and release date — for the library detail page. Synced/manual rows (itemId) are served from the platform's official store API (Steam appdetails by appid, Epic store-content by product slug, GOG product record by id, exact-title Steam search as labelled fallback, English intros translated to Chinese) and cached on the library row; a miss is cached for a week so it is not refetched on every open. Claimed rows (dealId) reuse the deal's already-enriched intro and screenshots, running the existing gallery enrichment once when the deal is still active and has none. Nothing is fabricated: when no official source has the game, found=false with empty fields.",
    request: z.object({
      itemId: z.number().int().positive().optional(),
      dealId: z.number().int().positive().optional(),
      ...authArg,
    }),
    response: z.object({
      found: z.boolean(),
      about: z.string().nullable(),
      gallery: z.array(z.string()),
      genres: z.array(z.string()),
      developer: z.string().nullable(),
      publisher: z.string().nullable(),
      releaseDate: z.string().nullable(),
      sourceLabel: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const out = (d: LibGameDetail, found: boolean) => ({
        found,
        about: d.about,
        gallery: d.gallery,
        genres: d.genres,
        developer: d.developer,
        publisher: d.publisher,
        releaseDate: d.releaseDate,
        sourceLabel: d.sourceLabel,
      });

      // Claimed entries live on the deal row, which the daily enrichment
      // already fills with a real intro + screenshots.
      if (args.dealId != null) {
        const label = "限免条目 · 官方商店";
        const readDeal = async () => (await db.select().from(schema.deals).where(eq(schema.deals.id, args.dealId as number)))[0];
        let deal = await readDeal();
        if (!deal) return out(emptyLibDetail(label), false);
        if (deal.status === "active" || deal.status === "upcoming") {
          if (parseGallery(deal.gallery).length === 0 || !deal.aboutZh) {
            try {
              await enrichGalleryRows(ctx, { dealId: deal.id, limit: 1 });
              deal = (await readDeal()) ?? deal;
            } catch {
              // best-effort: serve whatever the deal already has
            }
          }
        }
        const about = deal.aboutZh?.trim() || deal.descriptionZh?.trim() || null;
        const gallery = parseGallery(deal.gallery);
        return out(
          { ...emptyLibDetail(label), about: about ? about.slice(0, 1400) : null, gallery },
          Boolean(about) || gallery.length > 0,
        );
      }

      if (args.itemId == null) return out(emptyLibDetail(""), false);
      const rows = await db
        .select()
        .from(schema.libraryItems)
        .where(and(eq(schema.libraryItems.id, args.itemId), eq(schema.libraryItems.userId, uid)));
      const row = rows[0];
      if (!row) return out(emptyLibDetail(""), false);

      const platformLabel =
        row.platform === "epic" ? "Epic 商店" : row.platform === "steam" ? "Steam 商店" : "GOG 商店";
      const fromCache = (): LibGameDetail | null => {
        if (row.detailAt == null) return null;
        let meta: Partial<LibGameDetail> = {};
        try {
          meta = row.detailMeta ? (JSON.parse(row.detailMeta) as Partial<LibGameDetail>) : {};
        } catch {
          meta = {};
        }
        return {
          about: row.detailAbout ?? null,
          gallery: parseGallery(row.detailGallery),
          genres: Array.isArray(meta.genres) ? meta.genres : [],
          developer: meta.developer ?? null,
          publisher: meta.publisher ?? null,
          releaseDate: meta.releaseDate ?? null,
          sourceLabel: typeof meta.sourceLabel === "string" && meta.sourceLabel ? meta.sourceLabel : platformLabel,
        };
      };
      const cached = fromCache();
      const hasContent = cached != null && (cached.about != null || cached.gallery.length > 0);
      // Positive results are cached for good; a miss is retried after a week.
      if (cached && (hasContent || Date.now() - (row.detailAt ?? 0) < 7 * 24 * 3600 * 1000)) {
        return out(cached, hasContent);
      }

      let detail: LibGameDetail | null = null;
      try {
        if (row.platform === "steam" && /^\d+$/.test(row.extKey)) {
          detail = await fetchSteamAppDetail(row.extKey);
        } else if (row.platform === "epic" && row.storeSlug) {
          detail = await fetchEpicProductDetail(row.storeSlug);
        } else if (row.platform === "gog" && /^\d+$/.test(row.extKey)) {
          detail = await fetchGogProductDetail(row.extKey);
        }
      } catch {
        detail = null;
      }
      if (!detail || (!detail.about && detail.gallery.length === 0)) {
        // Fallback: the same game on Steam, matched by exact title (the
        // deal enrichment's proven channel). The label says where the
        // content really came from.
        try {
          const g = await fetchSteamGallery(baseTitle(row.title));
          if (g && (g.about || g.images.length > 0)) {
            detail = {
              about: g.about,
              gallery: g.images.filter((u) => u !== row.imageUrl),
              genres: [],
              developer: null,
              publisher: null,
              releaseDate: null,
              sourceLabel: "Steam 商店",
            };
          }
        } catch {
          // keep the platform result (possibly null)
        }
      }
      const finalDetail = detail ?? emptyLibDetail(platformLabel);
      if (finalDetail.about && needsTranslation(finalDetail.about)) {
        const map = await translateAbouts(ctx, [{ externalId: `lib-${row.id}`, text: finalDetail.about }]);
        const zh = map.get(`lib-${row.id}`);
        if (zh) finalDetail.about = zh;
      }
      const found = Boolean(finalDetail.about) || finalDetail.gallery.length > 0;
      await db
        .update(schema.libraryItems)
        .set({
          detailAbout: finalDetail.about,
          detailGallery: finalDetail.gallery.length > 0 ? JSON.stringify(finalDetail.gallery) : null,
          detailMeta: JSON.stringify({
            genres: finalDetail.genres,
            developer: finalDetail.developer,
            publisher: finalDetail.publisher,
            releaseDate: finalDetail.releaseDate,
            sourceLabel: finalDetail.sourceLabel,
          }),
          detailAt: Date.now(),
        })
        .where(eq(schema.libraryItems.id, row.id));
      return out(finalDetail, found);
    },
  }),

  refreshPlaytimes: defineAction({
    description: "Refreshes real playtime for the signed-in account's synced library games without a full re-sync, and also runs as part of every library sync. Steam: the Web API's GetOwnedGames playtime_forever (needs the user's own API key). Epic: the launcher library-service per-artifact playtime endpoint matched via the appName keys stored at sync; games the endpoint served but has no record for are marked 0 (never played) — when the endpoint itself fails, nothing is written. GOG: Galaxy's gameplay /users/<id>/stats endpoint (route probed live); if GOG does not return usable per-game totals, the platform is reported and stored as not supporting playtime sync — playtime is never estimated or faked. Each result reports how many games were updated and stores playtimeUpdatedAt per game.",
    request: z.object({ ...authArg }),
    response: z.object({
      ok: z.boolean(),
      results: z.array(
        z.object({
          platform: z.enum(["epic", "steam", "gog"]),
          state: z.enum(["updated", "unsupported", "not-bound", "error"]),
          updated: z.number(),
          note: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      type Result = { platform: PlatformKey; state: "updated" | "unsupported" | "not-bound" | "error"; updated: number; note: string };
      const results: Result[] = [];
      const at = Date.now();
      for (const platform of ["epic", "steam", "gog"] as PlatformKey[]) {
        const row = await getAccountRow(ctx, uid, platform);
        if (!row || (!row.accountRef && !row.accessToken)) {
          results.push({ platform, state: "not-bound", updated: 0, note: `未绑定 ${platform === "epic" ? "Epic" : platform === "steam" ? "Steam" : "GOG"} 账号` });
          continue;
        }
        try {
          if (platform === "steam") {
            if (!row.steamApiKey || !row.accountRef) {
              results.push({ platform, state: "error", updated: 0, note: "Steam 还没有填入你自己的 Web API Key，无法拉取时长" });
              continue;
            }
            const res = await fetch(
              `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(row.steamApiKey)}&steamid=${encodeURIComponent(row.accountRef)}&include_appinfo=1&include_played_free_games=1&format=json`,
            );
            if (!res.ok) throw new Error(`Steam Web API HTTP ${res.status}`);
            const data = (await res.json()) as Record<string, unknown>;
            const games = Array.isArray((data.response as Record<string, unknown> | undefined)?.games)
              ? ((data.response as Record<string, unknown>).games as Record<string, unknown>[])
              : [];
            const byApp = new Map<string, number>();
            for (const g of games) {
              if (typeof g.appid === "number" && typeof g.playtime_forever === "number") byApp.set(String(g.appid), g.playtime_forever);
            }
            const rows = await db
              .select()
              .from(schema.libraryItems)
              .where(and(eq(schema.libraryItems.userId, uid), eq(schema.libraryItems.platform, "steam"), eq(schema.libraryItems.source, "sync")));
            let updated = 0;
            for (const r of rows) {
              const mins = byApp.get(r.extKey);
              if (typeof mins === "number") {
                await db.update(schema.libraryItems).set({ playtimeMinutes: mins, playtimeUpdatedAt: at }).where(eq(schema.libraryItems.id, r.id));
                updated++;
              }
            }
            await savePlaytimeStatus(ctx, uid, "steam", "ok", "时长来自 Steam Web API GetOwnedGames 的 playtime_forever");
            results.push({ platform, state: "updated", updated, note: `已更新 ${updated} 款 Steam 游戏的时长` });
          } else if (platform === "epic") {
            if (!row.accountRef) throw new Error("Epic 绑定缺少账号 ID");
            const token = await epicAccessToken(ctx, uid, row);
            const pt = await fetchEpicPlaytime(token, row.accountRef);
            if (!pt.ok) {
              const note = `Epic 时长接口没有返回数据（HTTP ${pt.status || "连接失败"}），该平台暂不支持时长同步`;
              await savePlaytimeStatus(ctx, uid, "epic", "unsupported", note);
              results.push({ platform, state: "unsupported", updated: 0, note });
              continue;
            }
            if (pt.map.size === 0) {
              results.push({ platform, state: "error", updated: 0, note: "Epic 本次没有返回任何时长记录，现有数据未改动" });
              continue;
            }
            let rows = await db
              .select()
              .from(schema.libraryItems)
              .where(and(eq(schema.libraryItems.userId, uid), eq(schema.libraryItems.platform, "epic"), eq(schema.libraryItems.source, "sync")));
            // Rows synced before playKeys existed carry no match keys, so
            // no playtime could ever land on them (measured on the real
            // library: 767 rows, all playKeys NULL). Rebuild them with a
            // full library sync — which stores the keys and applies the
            // same playtime map — then continue with the fresh rows.
            let resynced = false;
            if (rows.some((r) => !r.playKeys)) {
              try {
                await syncEpicLibrary(ctx, uid);
                resynced = true;
                rows = await db
                  .select()
                  .from(schema.libraryItems)
                  .where(and(eq(schema.libraryItems.userId, uid), eq(schema.libraryItems.platform, "epic"), eq(schema.libraryItems.source, "sync")));
              } catch {
                // sync failed: fall through and update the rows we can
              }
            }
            let updated = 0;
            let matched = 0;
            for (const r of rows) {
              let keys: string[] = [];
              try {
                if (r.playKeys) keys = JSON.parse(r.playKeys) as string[];
              } catch {
                keys = [];
              }
              let minutes: number | null = null;
              for (const k of keys) {
                const m = pt.map.get(k);
                if (typeof m === "number") {
                  minutes = (minutes ?? 0) + m;
                  matched++;
                }
              }
              // Endpoint served data but has no record for this game →
              // genuinely never played (0). Rows without stored keys keep
              // their previous value: their match keys are unknown.
              if (minutes == null && keys.length > 0) minutes = 0;
              if (minutes != null) {
                await db.update(schema.libraryItems).set({ playtimeMinutes: minutes, playtimeUpdatedAt: at }).where(eq(schema.libraryItems.id, r.id));
                updated++;
              }
            }
            await savePlaytimeStatus(ctx, uid, "epic", "ok", "时长来自 Epic 官方 library-service 时长接口");
            results.push({
              platform,
              state: "updated",
              updated,
              note:
                `已更新 ${updated} 款 Epic 游戏的时长（Epic 返回了 ${pt.entries} 款有游玩记录的游戏，命中库内 ${matched} 条记录，其余有匹配键的按未玩过计 0）` +
                (resynced ? "；本次顺带重新同步了游戏库，为旧数据补齐时长匹配键" : ""),
            });
          } else {
            if (!row.accountRef) throw new Error("GOG 绑定缺少账号 ID");
            const token = await gogAccessToken(ctx, uid, row);
            const gp = await fetchGogPlaytime(token, row.accountRef);
            if (!gp.ok) {
              const note = `该平台暂不支持时长同步（${gp.note}）`;
              await savePlaytimeStatus(ctx, uid, "gog", "unsupported", note);
              results.push({ platform, state: "unsupported", updated: 0, note });
              continue;
            }
            const rows = await db
              .select()
              .from(schema.libraryItems)
              .where(and(eq(schema.libraryItems.userId, uid), eq(schema.libraryItems.platform, "gog"), eq(schema.libraryItems.source, "sync")));
            let updated = 0;
            for (const r of rows) {
              const mins = gp.map.get(r.extKey);
              if (typeof mins === "number") {
                await db.update(schema.libraryItems).set({ playtimeMinutes: mins, playtimeUpdatedAt: at }).where(eq(schema.libraryItems.id, r.id));
                updated++;
              }
            }
            await savePlaytimeStatus(ctx, uid, "gog", "ok", "时长来自 GOG Galaxy gameplay 接口");
            results.push({ platform, state: "updated", updated, note: `已更新 ${updated} 款 GOG 游戏的时长` });
          }
        } catch (e) {
          results.push({ platform, state: "error", updated: 0, note: `更新失败：${e instanceof Error ? e.message : String(e)}` });
        }
      }
      ctx.invalidateQueries();
      return { ok: results.some((r) => r.state === "updated"), results };
    },
  }),

  removeLibraryItem: defineAction({
    description: "Removes one synced or previously manually added game from the signed-in account's library. Claimed-deal entries are removed by un-marking the deal instead.",
    request: z.object({ itemId: z.number().int().positive(), ...authArg }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      await db
        .delete(schema.libraryItems)
        .where(and(eq(schema.libraryItems.id, args.itemId), eq(schema.libraryItems.userId, uid)));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  redeemPrimeGogCode: defineAction({
    description: "Redeems a Prime Gaming GOG code for real: takes the code the user copied from Amazon's claim page and calls GOG's official bonus-code API (redeem.gog.com/v1/bonusCodes, the same endpoints www.gog.com/redeem uses) with the signed-in account's stored GOG Galaxy Bearer token, then syncs the GOG library and marks the game claimed ONLY when the game verifiably arrived in that library. Any GOG rejection (invalid / used code, expired token, captcha demand) is returned verbatim in the note, together with a fallback link to GOG's official redeem page with this code pre-filled in the URL path.",
    request: z.object({ dealId: z.number().int().positive(), code: z.string().min(4).max(80), ...authArg }),
    response: z.object({
      ok: z.boolean(),
      state: z.enum(["redeemed", "not-bound", "not-prime", "wrong-channel", "auth-expired", "redeem-failed", "not-in-library"]),
      note: z.string(),
      fallbackUrl: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const code = args.code.trim().toUpperCase().replace(/\s+/g, "");
      // GOG's own redeem page reads the code out of the /redeem/<code> path
      // and pre-fills its input (verified in its JS bundle), so this link is
      // the honest manual fallback, never labelled as auto-redeem.
      const fallbackUrl = `https://www.gog.com/redeem/${encodeURIComponent(code)}`;
      const rows = await db.select().from(schema.deals).where(eq(schema.deals.id, args.dealId));
      const deal = rows[0];
      if (!deal || !deal.externalId.startsWith("prime-")) {
        return { ok: false, state: "not-prime" as const, note: "这不是一款 Prime 会员游戏", fallbackUrl: null };
      }
      if (primeChannelOf(deal.platform) !== "gog") {
        return { ok: false, state: "wrong-channel" as const, note: "这款游戏不是 GOG 兑换码渠道", fallbackUrl: null };
      }
      const gogRow = await getAccountRow(ctx, uid, "gog");
      if (!gogRow || !gogRow.accountRef) {
        return {
          ok: false,
          state: "not-bound" as const,
          note: "还没绑定 GOG 账号：自动兑换要用你绑定的 GOG 授权，先到「我的 → 平台账号」绑定 GOG 再回来。",
          fallbackUrl,
        };
      }
      let token: string;
      try {
        token = await gogAccessToken(ctx, uid, gogRow);
      } catch (e) {
        return {
          ok: false,
          state: "auth-expired" as const,
          note: `GOG 登录态不可用（${e instanceof Error ? e.message : String(e)}），请到「我的」重新绑定 GOG 后再试。`,
          fallbackUrl,
        };
      }
      let outcome: GogRedeemOutcome;
      try {
        outcome = await gogRedeemAttempt(token, code);
      } catch (e) {
        return {
          ok: false,
          state: "redeem-failed" as const,
          note: `兑换请求没能发到 GOG（${e instanceof Error ? e.message : String(e)}），请稍后再试，或用下方预填了这个码的官方兑换页手动完成。`,
          fallbackUrl,
        };
      }
      if (outcome.kind === "failed" && outcome.status === 401) {
        return {
          ok: false,
          state: "auth-expired" as const,
          note: `GOG 拒绝了已存的授权（${outcome.message}），请到「我的」重新绑定 GOG 后再试。`,
          fallbackUrl,
        };
      }
      // A code GOG does not recognise (or an expired one) can never be the
      // reason a game sits in the library — do not sync, and never let a
      // pre-existing library hit masquerade as "redeemed".
      if (outcome.kind === "failed" && (outcome.codeState === "missing" || outcome.codeState === "expired")) {
        return {
          ok: false,
          state: "redeem-failed" as const,
          note: `${outcome.message}。请核对 Amazon 领取页上的兑换码有没有输错；确认无误还是不行的话需要回 Amazon 换一个新码，也可以用下面预填了这个码的 GOG 官方页手动试一次。`,
          fallbackUrl,
        };
      }
      // Mark claimed only when GOG itself vouches for the code (redeem
      // accepted, or the code was already consumed) AND the game is
      // verifiably in the library.
      const codeVouched = outcome.kind === "redeemed" || outcome.codeState === "used";
      let inLibrary = false;
      if (codeVouched) {
        try {
          await syncGogLibrary(ctx, uid);
          const lib = await db
            .select()
            .from(schema.libraryItems)
            .where(
              and(
                eq(schema.libraryItems.userId, uid),
                eq(schema.libraryItems.platform, "gog"),
                eq(schema.libraryItems.source, "sync"),
              ),
            );
          const want = normName(baseTitle(deal.title));
          inLibrary = lib.some((i) => normName(i.title) === want);
        } catch {
          inLibrary = false;
        }
      }
      if (inLibrary && codeVouched) {
        await db
          .insert(schema.marks)
          .values({ dealId: deal.id, kind: "claimed", userId: uid })
          .onConflictDoNothing();
        ctx.invalidateQueries();
        return {
          ok: true,
          state: "redeemed" as const,
          note:
            outcome.kind === "redeemed"
              ? "兑换成功：已同步 GOG 游戏库并验证这款游戏到账，已标记已领、归入游戏库 GOG 分组。"
              : "已同步 GOG 游戏库并验证这款游戏在库里（这个码此前已兑换进你的账号），已标记已领、归入游戏库 GOG 分组。",
          fallbackUrl: null,
        };
      }
      if (outcome.kind === "redeemed") {
        return {
          ok: false,
          state: "not-in-library" as const,
          note: "GOG 兑换接口接受了这个码，但同步游戏库后还没查到这款游戏——可能还在发放中，过一会儿再点一次「自动兑换」确认；没验证到账前不会标记已领。",
          fallbackUrl,
        };
      }
      const usedAlready = outcome.kind === "failed" && outcome.codeState === "used";
      const needsCaptcha = outcome.kind === "failed" && (outcome.captcha || /captcha|验证码/i.test(outcome.message));
      return {
        ok: false,
        state: "redeem-failed" as const,
        note: usedAlready
          ? "这个码在 GOG 那边已经是「已使用」状态（每个码只能用一次）。如果刚才其实兑换成功了，过几十秒再点一次「自动兑换」——会自动核对你 GOG 游戏库，到账就标记已领；如果确实没换到，需要回 Amazon 换一个新码。"
          : needsCaptcha
            ? "这次 GOG 要求网页验证码，自动兑换被拦下了（不是你操作的问题，GOG 现在对接口调用普遍要求人机验证）。用下面预填了这个码的 GOG 官方兑换页点一下就能完成；如果它提示码已用过，说明这个码之前已经换进你的账号了，直接点「已领，完成」即可。"
            : `GOG 没有兑换成功（${outcome.message}）。可以用下方预填了这个码的 GOG 官方兑换页手动完成，成功后再点「已领，完成」。`,
        fallbackUrl,
      };
    },
  }),

  attemptPrimeAutoClaim: defineAction({
    description: "The Prime queue's Epic-channel 「检测入库」 check: syncs the signed-in account's bound Epic library with the stored Epic token and marks the Prime game claimed ONLY when the game verifiably sits in that library (i.e. Amazon already granted it after the user claimed on Amazon with the Epic account linked). Also reports whether the title is a $0 offer in Epic's own free-games feed. GOG-channel games are redeemed for real by redeemPrimeGogCode instead; this action just points there. It never fabricates a claim.",
    request: z.object({ dealId: z.number().int().positive(), ...authArg }),
    response: z.object({
      ok: z.boolean(),
      state: z.enum(["already-in-library", "not-auto-claimable", "not-prime", "channel-unsupported"]),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const uid = await ownerId(ctx, args.authToken);
      const rows = await db.select().from(schema.deals).where(eq(schema.deals.id, args.dealId));
      const deal = rows[0];
      if (!deal || !deal.externalId.startsWith("prime-")) {
        return { ok: false, state: "not-prime" as const, note: "这不是一款 Prime 会员游戏" };
      }
      const channel = primeChannelOf(deal.platform);
      if (channel === "gog") {
        return {
          ok: false,
          state: "not-auto-claimable" as const,
          note: "GOG 渠道是兑换码：在队列条目里把亚马逊领取页给的兑换码粘贴进输入框，点「自动兑换」就会用你绑定的 GOG 授权兑换入库（redeemPrimeGogCode）。",
        };
      }
      if (channel !== "epic") {
        return {
          ok: false,
          state: "channel-unsupported" as const,
          note: `${PRIME_CHANNEL_LABEL[channel]} 渠道只能在亚马逊领取页完成领取，没有可由服务端代领的接口。`,
        };
      }
      // Epic channel: (b) already granted into the bound Epic library?
      const epicRow = await getAccountRow(ctx, uid, "epic");
      if (!epicRow || !epicRow.accountRef) {
        return {
          ok: false,
          state: "not-auto-claimable" as const,
          note: "还没在空间绑定 Epic 账号：「检测入库」要靠已绑定的 Epic 授权同步你的游戏库来核对。先到「我的 → 平台账号」绑定 Epic；另外别忘了在亚马逊领取页里也要关联同一个 Epic 账号，领取后才会自动发放进库。",
        };
      }
      if (epicRow && epicRow.accountRef) {
        try {
          const sync = await syncEpicLibrary(ctx, uid);
          void sync;
          const lib = await db
            .select()
            .from(schema.libraryItems)
            .where(
              and(
                eq(schema.libraryItems.userId, uid),
                eq(schema.libraryItems.platform, "epic"),
                eq(schema.libraryItems.source, "sync"),
              ),
            );
          const want = normName(baseTitle(deal.title));
          if (lib.some((i) => normName(i.title) === want)) {
            await db
              .insert(schema.marks)
              .values({ dealId: deal.id, kind: "claimed", userId: uid })
              .onConflictDoNothing();
            ctx.invalidateQueries();
            return {
              ok: true,
              state: "already-in-library" as const,
              note: "已在你绑定的 Epic 游戏库里查到这款游戏（亚马逊已发放），已自动标记为已领。",
            };
          }
        } catch {
          // fall through to the feed check / honest blocker note
        }
      }
      // (a) is the title a $0 offer in Epic's own free-games feed right now?
      let inFreeFeed = false;
      try {
        const feed = await fetchEpic();
        const want = normName(baseTitle(deal.title));
        inFreeFeed = feed.some((f) => f.status === "active" && normName(baseTitle(f.title)) === want);
      } catch {
        inFreeFeed = false;
      }
      if (inFreeFeed) {
        return {
          ok: false,
          state: "not-auto-claimable" as const,
          note: "这款游戏同时在 Epic 本周免费里，但 Epic 商城的下单接口只接受 epicgames.com 的网页会话并带 Cloudflare 人机校验，启动器 token 调不通（实测返回挑战页）——仍需在队列里打开亚马逊领取页领取，或去 Epic 商城页手动领。",
        };
      }
      return {
        ok: false,
        state: "not-auto-claimable" as const,
        note: "还没在你绑定的 Epic 游戏库里查到这款游戏——多半是还没在亚马逊领取页点领取，或领取后还没到账，没有标记已领。Prime 的 Epic 游戏没有兑换码：先在亚马逊账号里关联 Epic 账号，在亚马逊点领取后就直接发放进 Epic 库；领完等一会儿再回来点「检测入库」。",
      };
    },
  }),

  verifyBatchClaim: defineAction({
    description: "End-of-queue verification for the games page's one-tap claim queue: the user has claimed the selected games on each platform's OWN official pages; this action re-syncs every involved bound platform library (Epic / Steam / GOG, Prime games via their redemption channel) and reconciles each selected game against the REAL synced rows by normalized title. It writes no claimed marks and no library rows of its own — a game counts as verified only when it verifiably sits in the bound official account's library. Epic MOBILE deals verify stricter: the matching library row must carry the mobile device-platform mark from the Epic catalog evidence — a PC-only copy of the same title does NOT verify a mobile claim; unconfirmed mobile rows are reported with Epic's official transactions page as the authority instead of being called 入库. Requires a signed-in in-app account.",
    request: z.object({
      items: z
        .array(z.object({ dealId: z.number().int().positive(), guided: z.boolean() }))
        .min(1)
        .max(100),
      ...authArg,
    }),
    response: batchVerifyResponse,
    async handler(ctx, args): Promise<z.infer<typeof batchVerifyResponse>> {
      const db = ctx.db<typeof schema>();
      const uid = await resolveUserId(ctx, args.authToken);
      if (uid == null) {
        return { ok: false, needLogin: true, results: [], syncNotes: [] };
      }
      type Plat = "epic" | "steam" | "gog";
      const PLAT_LABEL: Record<Plat, string> = { epic: "Epic", steam: "Steam", gog: "GOG" };
      type Work = {
        dealId: number;
        guided: boolean;
        title: string;
        keys: string[];
        plat: Plat | null;
        unvNote: string | null;
        mobile: boolean;
      };
      const works: Work[] = [];
      for (const it of args.items) {
        const dealRows = await db.select().from(schema.deals).where(eq(schema.deals.id, it.dealId));
        const deal = dealRows[0];
        if (!deal) {
          works.push({ dealId: it.dealId, guided: it.guided, title: `条目 #${it.dealId}`, keys: [], plat: null, unvNote: "这条限免已下架，无法验库", mobile: false });
          continue;
        }
        let plat: Plat | null = null;
        let unvNote: string | null = null;
        if (deal.externalId.startsWith("prime-")) {
          const ch = primeChannelOf(deal.platform);
          if (ch === "epic" || ch === "gog") plat = ch;
          else unvNote = `${PRIME_CHANNEL_LABEL[ch]} 渠道在亚马逊侧完成领取，空间没有可同步核对的官方游戏库，无法验库`;
        } else {
          const gp = classifyGamePlatform(deal);
          if (gp === "epic" || gp === "steam" || gp === "gog") plat = gp;
          else unvNote = "这款的来源不在 Epic / Steam / GOG，没有可同步核对的官方游戏库，无法验库";
        }
        works.push({
          dealId: deal.id,
          guided: it.guided,
          title: deal.titleZh?.trim() || deal.title,
          keys: [normName(baseTitle(deal.title)), ...(deal.titleZh ? [normName(baseTitle(deal.titleZh))] : [])].filter((k) => k.length > 0),
          plat,
          unvNote,
          mobile: deal.externalId.startsWith("epic-mobile-"),
        });
      }
      // One real sync per involved platform, then reconcile by title.
      const syncNotes: { platform: Plat; note: string }[] = [];
      const platState = new Map<Plat, { ok: boolean; note: string; count: number; titles: Set<string>; deviceByTitle: Map<string, Set<string>> }>();
      const needed = [...new Set(works.map((w) => w.plat).filter((p): p is Plat => p != null))];
      for (const p of needed) {
        const row = await getAccountRow(ctx, uid, p);
        if (!row || !row.accountRef) {
          platState.set(p, { ok: false, note: `还没绑定 ${PLAT_LABEL[p]} 账号，无法同步验库 — 先到「我的」绑定后再回来验库`, count: 0, titles: new Set(), deviceByTitle: new Map() });
          continue;
        }
        if (p === "steam" && !row.steamApiKey) {
          platState.set(p, { ok: false, note: "Steam 已绑定但还没填 API Key，同步不了游戏库 — 在「我的」的 Steam 卡里补填 Key 后再验库", count: 0, titles: new Set(), deviceByTitle: new Map() });
          continue;
        }
        try {
          const r = await syncPlatform(ctx, uid, p);
          const lib = await db
            .select()
            .from(schema.libraryItems)
            .where(
              and(
                eq(schema.libraryItems.userId, uid),
                eq(schema.libraryItems.platform, p),
                eq(schema.libraryItems.source, "sync"),
              ),
            );
          const titles = new Set<string>();
          const deviceByTitle = new Map<string, Set<string>>();
          for (const li of lib) {
            titles.add(normName(li.title));
            titles.add(normName(baseTitle(li.title)));
            const devs = new Set((li.devicePlatforms ?? "").split(",").filter(Boolean));
            for (const k of [normName(li.title), normName(baseTitle(li.title))]) {
              const prev = deviceByTitle.get(k) ?? new Set<string>();
              for (const d of devs) prev.add(d);
              deviceByTitle.set(k, prev);
            }
          }
          platState.set(p, { ok: true, note: r.note, count: lib.length, titles, deviceByTitle });
          syncNotes.push({ platform: p, note: r.note });
        } catch (e) {
          platState.set(p, {
            ok: false,
            note: `同步 ${PLAT_LABEL[p]} 游戏库失败：${e instanceof Error ? e.message : String(e)}`,
            count: 0,
            titles: new Set(),
            deviceByTitle: new Map(),
          });
        }
      }
      const results = works.map((w): z.infer<typeof batchVerifyResponse>["results"][number] => {
        if (!w.plat) {
          return { dealId: w.dealId, title: w.title, status: "unverifiable", note: w.unvNote ?? "无法验库", linkUrl: null };
        }
        const st = platState.get(w.plat);
        if (!st || !st.ok) {
          return {
            dealId: w.dealId,
            title: w.title,
            status: "unverifiable",
            note: st?.note ?? "无法验库",
            linkUrl: w.mobile ? EPIC_TRANSACTIONS_URL : null,
          };
        }
        const matched = w.keys.filter((k) => st.titles.has(k));
        if (w.mobile) {
          // Mobile entitlement verification: the title alone is NOT
          // enough (the same game may sit in the library as a PC-only
          // copy) — a synced row must carry the explicit mobile mark.
          const hasMobile = matched.some((k) => st.deviceByTitle.get(k)?.has("mobile"));
          if (hasMobile) {
            return {
              dealId: w.dealId,
              title: w.title,
              status: "verified",
              note: "已在 Epic 官方游戏库中查到这款的手游权益（本次同步，库条目带手游标记）",
              linkUrl: null,
            };
          }
          if (w.guided) {
            return {
              dealId: w.dealId,
              title: w.title,
              status: "not_found",
              note:
                matched.length > 0
                  ? "同步到的 Epic 库里只有这款的 PC 版，没查到手游权益 — 手游版是否真领到以 Epic 账户交易页为准（下方链接），别把 PC 版当成手游已入库"
                  : "已同步 Epic 游戏库没查到这款的手游权益 — 可能还没领成功、到账有延迟，或手游权益未出现在库同步里；是否真领到以 Epic 账户交易页为准（下方链接）",
              linkUrl: EPIC_TRANSACTIONS_URL,
            };
          }
          return { dealId: w.dealId, title: w.title, status: "unprocessed", note: "这款没有在队列里处理", linkUrl: null };
        }
        if (matched.length > 0) {
          return { dealId: w.dealId, title: w.title, status: "verified", note: `已在 ${PLAT_LABEL[w.plat]} 官方游戏库中查到（本次同步）`, linkUrl: null };
        }
        if (w.guided) {
          return {
            dealId: w.dealId,
            title: w.title,
            status: "not_found",
            note: `已同步 ${PLAT_LABEL[w.plat]} 游戏库（${st.count} 款）没查到这款 — 可能还没在官方页领成功，或领取到账有延迟；稍后在「我的」里再同步一次游戏库复查`,
            linkUrl: null,
          };
        }
        return { dealId: w.dealId, title: w.title, status: "unprocessed", note: "这款没有在队列里处理", linkUrl: null };
      });
      ctx.invalidateQueries();
      return { ok: true, needLogin: false, results, syncNotes };
    },
  }),

  /**
   * Historical App Store freebie trend, derived from the daily price
   * snapshots (one row per tracked app per day). No synthetic data: every
   * point is a real iTunes Lookup price recorded at the time.
   */
  freeHistory: defineAction({
    description: "Historical limited-time-free trend from daily App Store price snapshots: per-day free app counts and per-app price point series. Data starts 2026-11-08 and grows daily.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      since: z.string(),
      until: z.string(),
      days: z.array(
        z.object({
          date: z.string(),
          tracked: z.number(),
          free: z.number(),
          newFree: z.number(),
          endedFree: z.number(),
        }),
      ),
      apps: z.array(
        z.object({
          trackId: z.number(),
          name: z.string(),
          iconUrl: z.string().nullable(),
          storeUrl: z.string().nullable(),
          currency: z.string(),
          points: z.array(z.object({ date: z.string(), cents: z.number() })),
          freeDays: z.number(),
          freeWindows: z.number(),
          currentCents: z.number(),
          wasCents: z.number(),
          isFreeNow: z.boolean(),
          firstDate: z.string(),
          lastDate: z.string(),
        }),
      ),
      summary: z.object({
        trackedApps: z.number(),
        currentlyFree: z.number(),
        everFree: z.number(),
        changedApps: z.number(),
        longestFreeDays: z.number(),
        dayCount: z.number(),
      }),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const snaps = await db.select().from(schema.appPriceSnapshots);
      const watch = await db.select().from(schema.appWatch);
      const watchMap = new Map(watch.map((w) => [w.trackId, w]));

      const allDates = Array.from(new Set(snaps.map((s) => s.snapshotDate))).sort();
      const dateIndex = new Map(allDates.map((d, i) => [d, i]));
      type DayAgg = { tracked: number; free: number; newFree: number; endedFree: number };
      const dayMap = new Map<string, DayAgg>(allDates.map((d) => [d, { tracked: 0, free: 0, newFree: 0, endedFree: 0 }]));
      for (const s of snaps) {
        const x = dayMap.get(s.snapshotDate);
        if (!x) continue;
        x.tracked++;
        if (s.priceCents === 0) x.free++;
      }

      const byTrack = new Map<number, { date: string; cents: number; currency: string }[]>();
      for (const s of snaps) {
        const arr = byTrack.get(s.trackId) ?? [];
        arr.push({ date: s.snapshotDate, cents: s.priceCents, currency: s.currency });
        byTrack.set(s.trackId, arr);
      }

      const apps = [];
      let everFree = 0;
      let changed = 0;
      let longest = 0;
      let currentlyFree = 0;
      for (const [trackId, raw] of byTrack) {
        const sorted = raw.slice().sort((a, b) => a.date.localeCompare(b.date));
        const points = sorted.map((x) => ({ date: x.date, cents: x.cents }));
        // Only compare observations on consecutive days: an app entering the
        // watchlist mid-series must not be mistaken for a fresh freebie.
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1]!;
          const cur = points[i]!;
          const gap = (dateIndex.get(cur.date) ?? 0) - (dateIndex.get(prev.date) ?? 0);
          if (gap !== 1) continue;
          const day = dayMap.get(cur.date);
          if (!day) continue;
          if (prev.cents !== 0 && cur.cents === 0) day.newFree++;
          if (prev.cents === 0 && cur.cents !== 0) day.endedFree++;
        }
        const freeDays = points.filter((p) => p.cents === 0).length;
        let windows = 0;
        points.forEach((p, i) => {
          if (p.cents === 0 && (i === 0 || points[i - 1]!.cents !== 0)) windows++;
        });
        const current = points[points.length - 1];
        if (!current) continue;
        const wasCents = Math.max(...points.map((p) => p.cents));
        const isChanged = points.some((p) => p.cents !== current.cents);
        const isFreeNow = current.cents === 0;
        if (freeDays > 0) everFree++;
        if (isChanged) changed++;
        if (isFreeNow) currentlyFree++;
        longest = Math.max(longest, freeDays);
        const w = watchMap.get(trackId);
        apps.push({
          trackId,
          name: w?.name ?? `App ${trackId}`,
          iconUrl: w?.iconUrl ?? null,
          storeUrl: w?.storeUrl ?? null,
          currency: sorted[sorted.length - 1]?.currency ?? "USD",
          points,
          freeDays,
          freeWindows: windows,
          currentCents: current.cents,
          wasCents,
          isFreeNow,
          firstDate: points[0]?.date ?? "",
          lastDate: current.date,
        });
      }
      // Free-now first, then the longest free streak, then apps with a real
      // price change ahead of flat ones.
      apps.sort(
        (a, b) =>
          Number(b.isFreeNow) - Number(a.isFreeNow) ||
          b.freeDays - a.freeDays ||
          Number(b.currentCents !== b.wasCents) - Number(a.currentCents !== a.wasCents) ||
          a.name.localeCompare(b.name),
      );
      return {
        ok: true,
        since: allDates[0] ?? "",
        until: allDates[allDates.length - 1] ?? "",
        days: allDates.map((date) => ({ date, ...dayMap.get(date)! })),
        apps,
        summary: {
          trackedApps: apps.length,
          currentlyFree,
          everFree,
          changedApps: changed,
          longestFreeDays: longest,
          dayCount: allDates.length,
        },
      };
    },
  }),

} satisfies ActionsModule;
