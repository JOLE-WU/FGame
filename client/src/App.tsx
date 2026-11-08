import {
memo,
useDeferredValue,
useEffect,
useLayoutEffect,
useMemo,
useRef,
useState,
type CSSProperties,
type FormEvent,
type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "./sdk-shim";
import { api, type ApiResponse } from "./api";
import { isNativePlatform, openPlatformLoginNative, onPlatformAuthCode } from "./auth-bridge";

type Deal = ApiResponse<typeof api, "listDeals">["deals"][number];
type AppPrice = ApiResponse<typeof api, "listAppPrices">["apps"][number];
type AccountData = ApiResponse<typeof api, "getAccounts">;
type PlatformStatus = AccountData["platforms"][number];
type LibraryGroup = ApiResponse<typeof api, "listLibrary">["groups"][number];
type LibraryEntry = LibraryGroup["entries"][number];
type BatchVerifyData = ApiResponse<typeof api, "verifyBatchClaim">;
type BatchVerifyResult = BatchVerifyData["results"][number];

type MainTab = "today" | "apps" | "games" | "cloud" | "mine";

// iOS 限免按 App Store 区服推荐。region code 与服务端 deals.regions 一致。
// "all" 只用于 UI 的默认「全部区服」，不是落库值。
const IOS_REGION_TABS: { code: string; cc: string; label: string }[] = [
  { code: "all", cc: "cn", label: "全部区服" },
  { code: "cn", cc: "cn", label: "国区" },
  { code: "us", cc: "us", label: "美区" },
  { code: "jp", cc: "jp", label: "日区" },
  { code: "in", cc: "in", label: "印度区" },
  { code: "hk", cc: "hk", label: "港区" },
];
const IOS_REGION_LABEL: Record<string, string> = {
  cn: "国区", us: "美区", jp: "日区", in: "印度区", hk: "港区",
};
type InnerTab = "today" | "all" | "claimed";
type PlatformKey = "epic" | "steam" | "gog";

const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "game", label: "游戏" },
  { key: "ios", label: "iOS 应用" },
  { key: "dlc", label: "DLC / 道具" },
  { key: "cloud", label: "云服务" },
  { key: "ai", label: "AI 额度" },
  { key: "other", label: "其他" },
] as const;

const GAME_PLATFORMS = [
  { key: "all", label: "全部" },
  { key: "epic", label: "Epic" },
  { key: "epic-mobile", label: "Epic 手游" },
  { key: "steam", label: "Steam" },
  { key: "gog", label: "GOG" },
  { key: "prime", label: "Prime 会员" },
  { key: "other", label: "其他" },
] as const;

const PLATFORM_NAMES: Record<PlatformKey, string> = { epic: "Epic", steam: "Steam", gog: "GOG" };
// Library groups also include the Prime redemption channels that have no
// bindable account of their own.
const LIBRARY_GROUP_NAMES: Record<string, string> = {
  epic: "Epic",
  steam: "Steam",
  gog: "GOG",
  amazon: "Amazon Games App",
  legacy: "Legacy Games",
};

// In-app account session: the token is issued by the server at register /
// login, persisted here, restored on open, and sent as `authToken` so
// bindings, library and marks resolve to the signed-in account.
type Session = { token: string; username: string };
const SESSION_TOKEN_KEY = "baipiao-session-token";
const SESSION_USER_KEY = "baipiao-session-user";
function loadSession(): Session | null {
  try {
    const t = localStorage.getItem(SESSION_TOKEN_KEY);
    const u = localStorage.getItem(SESSION_USER_KEY);
    return t && u ? { token: t, username: u } : null;
  } catch {
    return null;
  }
}
function storeSession(s: Session | null) {
  try {
    if (s) {
      localStorage.setItem(SESSION_TOKEN_KEY, s.token);
      localStorage.setItem(SESSION_USER_KEY, s.username);
    } else {
      localStorage.removeItem(SESSION_TOKEN_KEY);
      localStorage.removeItem(SESSION_USER_KEY);
    }
  } catch {
    // storage unavailable — the session simply won't persist
  }
}

// UI theme (AURORA GLASS light/dark). The choice is applied by setting
// data-theme on <html>; the pre-paint script in index.html restores the
// localStorage value before first paint so there is no flash, and the
// App state below keeps it in sync (and mirrors it to the account
// server-side while signed in).
type UiTheme = "light" | "dark";
const THEME_KEY = "baipiao-theme";
function loadTheme(): UiTheme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function applyThemeAttr(t: UiTheme) {
  try {
    document.documentElement.dataset.theme = t;
  } catch {
    // no document (never in practice) — ignore
  }
}

function ThemeToggleButton({ theme, onToggle }: { theme: UiTheme; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
      title={theme === "dark" ? "浅色模式" : "深色模式"}
      onClick={onToggle}
      className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md"
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

// Amazon's official Prime Gaming home (login happens ONLY on Amazon's own
// pages; this app never shows an Amazon password field) and GOG's official
// redemption page, where a code claimed on Amazon is redeemed.
const AMAZON_HOME_URL = "https://gaming.amazon.com/home";
const GOG_REDEEM_URL = "https://www.gog.com/redeem";
const AVATAR_COLORS = ["#f04a22", "#1d6b48", "#514d40", "#17160f", "#b8860b", "#5b4a8a"];

type AvatarInfo = ApiResponse<typeof api, "getSessionUser">["avatar"];

/** The account avatar: the uploaded photo, or the initial-letter placeholder. */
function AvatarBadge({ username, avatar, size }: { username: string; avatar: AvatarInfo; size: number }) {
  if (avatar?.imageUrl) {
    return <img src={avatar.imageUrl} alt="" className="flex-none rounded-full bg-[var(--surface2)] object-cover" style={{ width: size, height: size }} />;
  }
  const bg = AVATAR_COLORS[username.length % AVATAR_COLORS.length] ?? "#514d40";
  const glyph = (username.trim()[0] ?? "羊").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex flex-none items-center justify-center rounded-full font-serif font-black text-white"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: Math.round(size * 0.42) }}
    >
      {glyph}
    </span>
  );
}

/**
 * Centre-crop a picked photo to a square and compress it to a JPEG data URL
 * of at most 256×256 and ~200KB, stepping quality (then size) down until it
 * fits — the server enforces the same 200KB cap on the decoded bytes.
 */
async function compressAvatarImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const render = (target: number, quality: number): string => {
      const canvas = document.createElement("canvas");
      canvas.width = target;
      canvas.height = target;
      const c2d = canvas.getContext("2d");
      if (!c2d) return "";
      c2d.drawImage(img, sx, sy, side, side, 0, 0, target, target);
      return canvas.toDataURL("image/jpeg", quality);
    };
    const fits = (dataUrl: string) => dataUrl.length > 0 && (dataUrl.length * 3) / 4 <= 200 * 1024;
    for (const q of [0.85, 0.72, 0.6, 0.48]) {
      const d = render(256, q);
      if (fits(d)) return d;
    }
    for (const q of [0.7, 0.55, 0.45]) {
      const d = render(192, q);
      if (fits(d)) return d;
    }
    return render(192, 0.4);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type SortKey = "expiry" | "newest" | "worth";
const PAGE_SIZE = 24;

// ---------- formatting helpers ----------

function money(cents: number | null): string | null {
  if (cents == null || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function priceText(cents: number, currency: string): string {
  if (cents === 0) return "免费";
  return currency === "USD" ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency}`;
}

function countdown(endAt: string | null, now: number): { text: string; urgent: boolean } | null {
  if (!endAt) return null;
  const diff = new Date(endAt).getTime() - now;
  if (diff <= 0) return { text: "已结束", urgent: true };
  const mins = Math.floor(diff / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days >= 2) return { text: `剩 ${days} 天`, urgent: false };
  if (days === 1) return { text: `剩 1 天 ${hours} 小时`, urgent: true };
  if (hours >= 1) return { text: `剩 ${hours} 小时 ${m} 分`, urgent: true };
  return { text: `剩 ${m} 分钟`, urgent: true };
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function isSameLocalDay(iso: string | null, ref: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

function endsWithin(endAt: string | null, now: number, hours: number): boolean {
  if (!endAt) return false;
  const t = new Date(endAt).getTime();
  return t > now && t - now <= hours * 3600000;
}

/** 把英文平台名翻成中文说法，专有名词保留。 */
function platformZh(raw: string): string {
  if (!raw) return "";
  let s = raw;
  s = s.replace(/Epic Games Store/gi, "Epic 商城");
  s = s.replace(/Steam/gi, "Steam");
  s = s.replace(/GOG\.com|GOG/gi, "GOG");
  s = s.replace(/Android/gi, "安卓");
  s = s.replace(/\bPC\b/g, "电脑");
  s = s.replace(/Itch\.io/gi, "Itch.io");
  s = s.replace(/Humble Bundle/gi, "Humble 慈善包");
  s = s.replace(/IndieGala/gi, "IndieGala");
  s = s.replace(/, /g, " · ");
  return s;
}

function categoryLabel(deal: Deal): string {
  if (deal.tags.includes("ai")) return "AI 免费额度";
  if (deal.tags.includes("cloud")) return "云服务";
  if (deal.tags.includes("ios") && !deal.tags.includes("game")) return "iOS 应用";
  if (deal.tags.includes("dlc")) return "DLC / 道具";
  if (deal.tags.includes("game")) return deal.tags.includes("ios") ? "手游" : "游戏";
  return "其他";
}

function dealTitle(deal: Deal): string {
  return deal.titleZh?.trim() || deal.title;
}

// ---------- shared editorial pieces ----------

function SectionHead({ no, title, en, right }: { no: string; title: string; en: string; right?: ReactNode }) {
  return (
    <div className="mb-3.5 mt-7 flex items-end justify-between gap-3 first:mt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-[var(--accent)]">{no} /</span>
        <h2 className="font-serif text-[20px] font-bold leading-none tracking-[0.03em] text-[var(--text)]">{title}</h2>
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--dim2)]">{en}</span>
      </div>
      {right ?? null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={`flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-[7px] text-[11px] font-medium leading-none backdrop-blur-md transition-colors ${
        active
          ? "border-transparent bg-grad font-bold text-[var(--accent-ink)] shadow-[0_0_16px_var(--accent-glow)]"
          : "border-[var(--border)] bg-[var(--surface2)] text-[var(--dim)]"
      }`}
    >
      {label}
      {count != null ? <em className="font-mono text-[10px] not-italic opacity-60">{count}</em> : null}
    </button>
  );
}

function ChipsRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="-mx-4 flex gap-[7px] overflow-x-auto px-4 pb-1 pt-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </div>
  );
}

/**
 * Cover image with a designed failure state, shared by EVERY image source
 * (Epic / Steam / GOG / deal feeds): when the URL errors — a dead CDN
 * link, a wrong image variant — the <img> swaps to the same themed
 * initial-letter placeholder used for missing covers, so the browser's
 * broken-image icon never shows. (Motivating case: GOG sync stored a
 * `_product_tile_256x256.jpg` URL variant GOG's image service answers
 * HTTP 400, which tiled the whole GOG library with broken-image icons.)
 */
function SafeImg({
  src,
  alt,
  className,
  style,
  label,
  phFontSize,
  loading,
  decoding,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  style?: CSSProperties;
  label: string;
  phFontSize?: number;
  loading?: "lazy" | "eager";
  decoding?: "async" | "auto" | "sync";
}) {
  const [badSrc, setBadSrc] = useState<string | null>(null);
  if (!src || badSrc === src) {
    return (
      <div aria-hidden="true" className={`${className ?? ""} flex items-center justify-center font-serif font-bold text-[var(--dim)]`} style={style}>
        <span style={phFontSize ? { fontSize: phFontSize } : undefined}>{(label.replace(/[《》]/g, "").trim()[0] ?? "游").toUpperCase()}</span>
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} style={style} loading={loading} decoding={decoding} onError={() => setBadSrc(src)} />;
}

function CoverTile({ deal, size }: { deal: Deal; size: number }) {
  const [logoBad, setLogoBad] = useState(false);
  // Cloud/AI entries show their brand logo on the plate (contain, never
  // cropped); everything else keeps the photo cover.
  if (deal.logoUrl && (deal.tags.includes("cloud") || deal.tags.includes("ai")) && !logoBad) {
    return (
      <div
        aria-hidden="true"
        className="flex-none overflow-hidden rounded-[10px] border border-[var(--border)]"
        style={{ width: size, height: size, background: "var(--logo-plate)" }}
      >
        <img
          src={deal.logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setLogoBad(true)}
          className="h-full w-full object-contain p-[16%]"
        />
      </div>
    );
  }
  return (
    <SafeImg
      src={deal.imageUrl}
      alt=""
      label={dealTitle(deal)}
      phFontSize={size * 0.36}
      loading="lazy"
      decoding="async"
      className="flex-none rounded-[10px] bg-[var(--surface2)] object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/** 紧凑左图右文行：整行点击进详情，没有任何操作按钮。 */
const MiniRow = memo(function MiniRow({ deal, now, onOpen, badge }: { deal: Deal; now: number; onOpen: (deal: Deal) => void; badge?: string }) {
  const cd = countdown(deal.endAt, now);
  const worth = money(deal.worthCents);
  const title = dealTitle(deal);
  const platLine = [categoryLabel(deal), platformZh(deal.platform)].filter(Boolean).join(" · ").toUpperCase();
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`查看详情：${title}`}
      onClick={() => onOpen(deal)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(deal);
        }
      }}
      className={`flex cursor-pointer items-center gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-[9px] shadow-[var(--glass-hi)] backdrop-blur-md transition-colors ${deal.hidden ? "opacity-60" : ""}`}
    >
      <CoverTile deal={deal} size={72} />
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-[13px] font-bold leading-[1.3] text-[var(--text)]">{title}</h4>
        <div className="mb-2 mt-[5px] flex items-center gap-1.5">
          <p className="min-w-0 truncate font-mono text-[9.5px] tracking-[0.03em] text-[var(--dim2)]">{platLine}</p>
          {deal.epicMobile ? (
            <span className="flex-none rounded-full bg-[var(--free-bg)] px-1.5 py-[2px] text-[9px] font-bold leading-none text-[var(--free-ink)]">
              手游版 {deal.mobilePlatforms.map((p) => (p === "android" ? "安卓" : "iOS")).join("/")}
            </span>
          ) : null}
          {deal.regionLocked ? (
            <span className="flex-none rounded-full bg-[var(--warn-bg)] px-1.5 py-[2px] text-[9px] font-bold leading-none text-[var(--warn)]">锁区</span>
          ) : null}
          {badge ? (
            <span className="flex-none rounded-full bg-[var(--free-bg)] px-1.5 py-[2px] text-[9px] font-bold leading-none text-[var(--free-ink)]">{badge}</span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-[7px]">
          {deal.status === "upcoming" ? (
            <b className="text-xs font-bold text-[var(--text)]">{worth ? `原价 ${worth}` : "即将免费"}</b>
          ) : (
            <>
              <b className="text-xs font-bold text-[var(--free-ink)]">免费</b>
              {worth ? <s className="font-mono text-[10px] text-[var(--dim2)]">{worth}</s> : null}
            </>
          )}
          <span className={`ml-auto flex-none font-mono text-[9.5px] font-medium ${deal.claimed ? "text-[var(--free-ink)]" : "text-[var(--accent)]"}`}>
            {deal.claimed ? "已领取" : deal.status === "upcoming" ? (deal.publishedAt ? `${fmtDate(deal.publishedAt)} 开始` : "即将开始") : cd ? cd.text : deal.externalId.startsWith("iosfree-") ? "限免中" : "长期"}
          </span>
        </div>
      </div>
    </article>
  );
});

/**
 * 游戏页专用行包装：长按（450ms）多选。指针按下起计时，移动超过 10px
 * （滚动/滑动）即取消，所以正常滑动和点进详情不受影响；长按触发后紧
 * 跟的那次 click 被吞掉，避免刚选中又被点掉。多选模式下整行点击改为
 * 切换选中（capture 阶段拦截，不进详情）；已在库里的行显示「已入库」
 * 且不可选。正常模式下行为与 MiniRow 完全一致。
 */
function SelectableGameRow({
  deal,
  now,
  selecting,
  selected,
  onOpen,
  onToggle,
  onLongPressFire,
}: {
  deal: Deal;
  now: number;
  selecting: boolean;
  selected: boolean;
  onOpen: (d: Deal) => void;
  onToggle: (d: Deal) => void;
  onLongPressFire: (d: Deal) => void;
}) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedAtRef = useRef(0);
  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clearTimer, []);
  const inLib = deal.inLibrary;
  return (
    <div
      className={`relative rounded-[14px] [-webkit-touch-callout:none] ${selected ? "shadow-[0_0_0_2px_var(--accent)]" : ""} ${selecting && inLib ? "opacity-70" : ""}`}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        startRef.current = { x: e.clientX, y: e.clientY };
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          firedAtRef.current = Date.now();
          try {
            navigator.vibrate?.(12);
          } catch {
            // 震动不支持就静默
          }
          onLongPressFire(deal);
        }, 450);
      }}
      onPointerMove={(e) => {
        const s = startRef.current;
        if (!s) return;
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clearTimer();
      }}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onPointerLeave={clearTimer}
      onContextMenu={(e) => e.preventDefault()}
      onClickCapture={(e) => {
        // 长按触发后紧跟的 click 一律吞掉（进/出多选都不该再触发行点击）
        if (Date.now() - firedAtRef.current < 400) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (selecting) {
          e.preventDefault();
          e.stopPropagation();
          if (!inLib) onToggle(deal);
        }
      }}
      onKeyDownCapture={(e) => {
        if (selecting && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          if (!inLib) onToggle(deal);
        }
      }}
    >
      <MiniRow deal={deal} now={now} onOpen={onOpen} />
      {selecting ? (
        inLib ? (
          <span className="absolute right-2 top-2 z-10 rounded-full border border-[var(--free-ink)] bg-[var(--free-bg)] px-2 py-1 text-[10px] font-bold leading-none text-[var(--free-ink)]">
            已入库
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={`absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[13px] font-black leading-none ${
              selected ? "border-transparent bg-grad text-[var(--accent-ink)]" : "border-[var(--glass-edge-strong)] bg-[rgba(8,14,34,0.55)] text-transparent"
            }`}
          >
            ✓
          </span>
        )
      ) : null}
    </div>
  );
}

/** 主推大卡：封面角标 + 墨黑倒计时条，整卡点击进详情。 */
function HeroCard({ deal, now, onOpen }: { deal: Deal; now: number; onOpen: (deal: Deal) => void }) {
  const cd = countdown(deal.endAt, now);
  const worth = money(deal.worthCents);
  const title = dealTitle(deal);
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`查看详情：${title}`}
      onClick={() => onOpen(deal)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(deal);
        }
      }}
      className="cursor-pointer overflow-hidden rounded-[20px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--shadow)] backdrop-blur-md"
    >
      <div className="relative h-[196px] overflow-hidden bg-[var(--surface2)]">
        <SafeImg src={deal.imageUrl} alt={title} label={title} phFontSize={60} className="h-full w-full bg-[var(--surface2)] object-cover" />
        <span className={`absolute left-3 top-3 z-[4] rounded-[8px] px-[9px] py-[7px] font-mono text-[10px] font-semibold leading-none tracking-[0.08em] text-[var(--accent-ink)] ${deal.claimed ? "bg-[var(--free-ink)]" : "bg-grad shadow-[0_0_16px_var(--accent-glow)]"}`}>
          {deal.claimed ? "已入库" : deal.status === "upcoming" ? "即将免费" : "限免 FREE"}
        </span>
        {worth ? (
          <span className="absolute right-3 top-3 z-[4] img-chip rounded-[8px] px-[9px] py-[7px] font-mono text-[10px] leading-none line-through decoration-[var(--accent)] decoration-[1.5px]">
            原价 {worth}
          </span>
        ) : null}
        {cd && deal.status !== "upcoming" && !deal.claimed ? (
          <div className="absolute bottom-2 right-2 z-[4] flex items-center gap-1.5 img-chip rounded-[12px] border border-[var(--border)] px-3 py-[9px] font-mono text-[10px] leading-none tracking-[0.04em]">
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            剩 <b className="font-semibold text-[var(--accent)]">{cd.text.replace("剩 ", "")}</b>
            {deal.endAt ? <span>· {fmtDate(deal.endAt)} 截止</span> : null}
          </div>
        ) : null}
      </div>
      <div className="p-4 pb-[14px]">
        <div className="mb-[11px] flex flex-wrap gap-1.5">
          <span className="border border-[var(--accent)] bg-[var(--accent-soft)] px-[7px] py-[5px] font-mono text-[9.5px] leading-none text-[var(--accent)]">
            {deal.status === "upcoming" ? "下期预告" : "限时领取"}
          </span>
          <span className="border border-[var(--border)] px-[7px] py-[5px] font-mono text-[9.5px] leading-none text-[var(--dim)]">
            {categoryLabel(deal)}
          </span>
          {deal.platform ? (
            <span className="border border-[var(--border)] px-[7px] py-[5px] font-mono text-[9.5px] uppercase leading-none text-[var(--dim)]">
              {platformZh(deal.platform)}
            </span>
          ) : null}
          {deal.epicMobile ? (
            <span className="border border-[var(--free-ink)] bg-[var(--free-bg)] px-[7px] py-[5px] font-mono text-[9.5px] leading-none text-[var(--free-ink)]">
              手游版 {deal.mobilePlatforms.map((p) => (p === "android" ? "安卓" : "iOS")).join("/")}
            </span>
          ) : null}
          {deal.regionLocked ? (
            <span className="border border-[var(--warn)] bg-[var(--warn-bg)] px-[7px] py-[5px] font-mono text-[9.5px] leading-none text-[var(--warn)]">本周锁区</span>
          ) : null}
        </div>
        <h3 className="font-serif text-[19px] font-bold leading-[1.4] text-[var(--text)]">{title}</h3>
        <p className="mb-4 mt-1 text-[11.5px] leading-[1.5] text-[var(--dim2)]">
          {deal.claimed ? "已领取，永久入库" : deal.status === "upcoming" ? "即将开启免费领取" : "免费领取，领取后永久保留"}
        </p>
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[22px] font-bold leading-none text-[var(--free-ink)]">{deal.status === "upcoming" ? (worth ?? "免费") : "免费"}</span>
          {worth && deal.status !== "upcoming" ? <s className="font-mono text-[11px] text-[var(--dim2)]">{worth}</s> : null}
        </div>
      </div>
    </article>
  );
}

function EmptyNote({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="rounded-[14px] border border-dashed border-[var(--border)] px-5 py-[38px] text-center">
      <b className="mb-1 block font-serif text-[15px] font-bold text-[var(--dim)]">{title}</b>
      {sub ? <p className="text-xs leading-[1.8] text-[var(--dim2)]">{sub}</p> : null}
    </div>
  );
}

// ---------- detail page ----------

const enrichAttempted = new Set<number>();

// Epic mobile-offer hop note (measured 2026-11-08, see DATA-PLAN
// "Epic 手游领取跳转实测"): on a PHONE browser, Epic routes the mobile
// offers' purchase deep link to its mobile-app download page instead of
// the checkout page — Epic's server-side behaviour for mobile-store
// offers, not something this page can change (the same link opened in a
// desktop browser lands on the $0 checkout). The copy states that
// honestly and gives the working route, instead of promising the
// checkout page or looping the user back to the same link.
const EPIC_MOBILE_HOP_NOTE =
  "注意：用手机打开上面的下单链接，会被 Epic 跳到手机端 App 下载页 — 这是 Epic 对手游商品的固定跳转，网页侧改不了。想在网页领取：长按复制链接，到电脑浏览器打开就是 0 元下单页，登录后点「下订单」即领完。";

function DealDetail({ deal, now, onClose, authToken, onQueueClaim }: { deal: Deal; now: number; onClose: () => void; authToken?: string; onQueueClaim?: (d: Deal) => void }) {
  const queryClient = useQueryClient();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [logoBad, setLogoBad] = useState(false);
  const mark = useMutation({
    mutationFn: (kind: "saved" | "claimed" | "hidden") => api.toggleMark({ dealId: deal.id, kind, authToken }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const del = useMutation({
    mutationFn: () => api.deleteCustomDeal({ dealId: deal.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      onClose();
    },
  });
  const enrich = useMutation({
    mutationFn: () => api.enrichGallery({ dealId: deal.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deals"] }),
  });

  const dealId = deal.id;
  const isGameOrApp = deal.tags.includes("game") || deal.tags.includes("ios");
  const needsEnrich = isGameOrApp && (deal.gallery.length === 0 || !deal.aboutZh);
  useEffect(() => {
    if (!needsEnrich || enrichAttempted.has(dealId)) return;
    enrichAttempted.add(dealId);
    enrich.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, needsEnrich]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightbox != null) setLightbox(null);
        else onClose();
      }
      if (lightbox != null && deal.gallery.length > 1) {
        if (e.key === "ArrowRight") setLightbox((i) => (i == null ? i : (i + 1) % deal.gallery.length));
        if (e.key === "ArrowLeft") setLightbox((i) => (i == null ? i : (i - 1 + deal.gallery.length) % deal.gallery.length));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lightbox, deal.gallery.length]);

  const cd = countdown(deal.endAt, now);
  const worth = money(deal.worthCents);
  const mainTitle = dealTitle(deal);
  const enTitle = deal.titleZh?.trim() && deal.title !== deal.titleZh ? deal.title : null;
  const metaLine = [categoryLabel(deal), platformZh(deal.platform)].filter(Boolean).join(" · ");
  const desc = deal.descriptionZh?.trim() || deal.description?.trim() || "";
  const instructions = deal.instructionsZh?.trim() || deal.instructions?.trim() || "";
  const intro = deal.aboutZh?.trim() || (deal.externalId.startsWith("epic-") ? desc : "");
  const introHeading = deal.tags.includes("game") ? "游戏介绍" : "应用介绍";
  // The main CTA is Epic's purchase deep link when claimUrl IS the
  // combined purchase URL assembled from the real offer ids — true for
  // epic-* rows and for GamerPower mobile duplicates the sync mirrored
  // the official offers onto. Mobile-ness follows the offers themselves
  // (all android/ios), so a mirrored GP row gets the same per-platform
  // buttons and app-download hop note as the official mobile row.
  // Cloud/AI entries lead with their brand logo on the plate (contain,
  // never cropped like the photo cover); a failed logo falls back to the
  // photo cover below.
  const brandLogo =
    deal.logoUrl && (deal.tags.includes("cloud") || deal.tags.includes("ai")) && !logoBad ? deal.logoUrl : null;
  const purchaseMain = deal.combinedPurchaseUrl != null && deal.claimUrl === deal.combinedPurchaseUrl;
  const mobileDeal =
    deal.epicMobile ||
    (purchaseMain && deal.epicOffers.length > 0 && deal.epicOffers.every((o) => o.platform === "android" || o.platform === "ios"));
  const thumbUrl = (u: string) => u.replace("/0x0ss.jpg", "/643x0w.jpg");

  const toggleCls = (active: boolean) =>
    `h-11 flex-1 rounded-[14px] border text-sm font-medium backdrop-blur-md transition-colors ${
      active
        ? "border-transparent bg-grad font-bold text-[var(--accent-ink)]"
        : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
    }`;

  return (
    <div className="v-scroll-only fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={`详情：${mainTitle}`}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <div className="sticky top-0 z-10 bg-[var(--bg)]/90 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-3">
          <button
            type="button"
            aria-label="返回列表"
            onClick={onClose}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-14">
        {brandLogo ? (
          <div className="relative aspect-[16/9] w-full overflow-hidden rounded-[20px] border border-[var(--border)]" style={{ background: "var(--logo-plate)" }}>
            <img
              src={brandLogo}
              alt={mainTitle}
              onError={() => setLogoBad(true)}
              className="absolute inset-0 m-auto max-h-[56%] max-w-[60%] object-contain"
            />
            <span className="absolute left-3 top-3 rounded-[8px] bg-grad px-[9px] py-[7px] font-mono text-[10px] font-semibold leading-none tracking-[0.08em] text-[var(--accent-ink)] shadow-[0_0_16px_var(--accent-glow)]">
              {deal.status === "upcoming" ? "即将免费" : "限免 FREE"}
            </span>
            {worth ? (
              <span className="absolute right-3 top-3 img-chip rounded-[8px] px-[9px] py-[7px] font-mono text-[10px] leading-none line-through decoration-[var(--accent)] decoration-[1.5px]">
                原价 {worth}
              </span>
            ) : null}
          </div>
        ) : deal.imageUrl ? (
          <div className="relative aspect-[16/9] w-full overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--surface2)]">
            <SafeImg src={deal.imageUrl} alt={mainTitle} label={mainTitle} phFontSize={60} className="absolute inset-0 h-full w-full bg-[var(--surface2)] object-cover" />
            <span className="absolute left-3 top-3 rounded-[8px] bg-grad px-[9px] py-[7px] font-mono text-[10px] font-semibold leading-none tracking-[0.08em] text-[var(--accent-ink)] shadow-[0_0_16px_var(--accent-glow)]">
              {deal.status === "upcoming" ? "即将免费" : "限免 FREE"}
            </span>
            {worth ? (
              <span className="absolute right-3 top-3 img-chip rounded-[8px] px-[9px] py-[7px] font-mono text-[10px] leading-none line-through decoration-[var(--accent)] decoration-[1.5px]">
                原价 {worth}
              </span>
            ) : null}
          </div>
        ) : null}

        {deal.gallery.length > 0 ? (
          <div className="mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="官方截图">
            {deal.gallery.map((u, i) => (
              <button key={u} type="button" aria-label={`放大查看截图 ${i + 1}`} onClick={() => setLightbox(i)} className="aspect-[16/10] w-[148px] flex-none snap-start overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface2)] sm:w-[200px]">
                <SafeImg src={thumbUrl(u)} alt={`${mainTitle} 官方截图 ${i + 1}`} label={mainTitle} phFontSize={28} className="h-full w-full bg-[var(--surface2)] object-cover" loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        ) : null}

        <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--dim2)]">{metaLine}</p>
        <h1 className="mt-1.5 font-serif text-[24px] font-black leading-[1.35] text-[var(--text)]">{mainTitle}</h1>
        {enTitle ? <p className="mt-1 font-mono text-[11px] text-[var(--dim2)]">{enTitle}</p> : null}

        <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          {deal.status === "upcoming" ? (
            <span className="font-serif text-xl font-bold text-[var(--text)]">{worth ? `原价 ${worth}` : "免费"}</span>
          ) : (
            <>
              <span className="font-serif text-xl font-bold text-[var(--free-ink)]">免费</span>
              {worth ? <s className="font-mono text-xs text-[var(--dim2)]">{worth}</s> : null}
            </>
          )}
          {deal.saved ? <span className="text-[13px] font-medium text-[var(--accent)]">★ 已收藏</span> : null}
          {deal.claimed ? <span className="text-[13px] font-medium text-[var(--free-ink)]">已领取</span> : null}
          {deal.hidden ? <span className="text-[13px] font-medium text-[var(--warn)]">不感兴趣</span> : null}
        </div>

        <dl className="mt-5 grid gap-2.5 rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-[var(--glass-hi)] backdrop-blur-md">
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-[var(--dim)]">状态</dt>
            <dd className="text-right text-[var(--text)]">{deal.status === "upcoming" ? "即将开始" : deal.status === "expired" ? "已结束" : "可领取"}</dd>
          </div>
          {deal.status === "upcoming" && deal.publishedAt ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">开始时间</dt>
              <dd className="text-right text-[var(--text)]">{fmtDate(deal.publishedAt)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-[var(--dim)]">到期</dt>
            <dd className={`text-right ${cd?.urgent ? "font-medium text-[var(--warn)]" : "text-[var(--text)]"}`}>
              {deal.endAt
                ? `${cd ? `${cd.text} · ` : ""}${fmtDate(deal.endAt)} 截止`
                : deal.externalId.startsWith("iosfree-")
                  ? "限时免费 · 恢复收费即下架"
                  : deal.gamePlatform === "prime"
                    ? "截止日待确认（官方未公布，以领取页为准）"
                    : "长期有效"}
            </dd>
          </div>
          {deal.publishedAt && deal.status !== "upcoming" ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">发布时间</dt>
              <dd className="text-right text-[var(--text)]">{fmtDate(deal.publishedAt)}</dd>
            </div>
          ) : null}
          {deal.usersCount != null && deal.usersCount > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">已领取</dt>
              <dd className="text-right text-[var(--text)]">{deal.usersCount.toLocaleString()} 人</dd>
            </div>
          ) : null}
          {deal.source ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">来源</dt>
              <dd className="text-right text-[var(--text)]">{deal.source}</dd>
            </div>
          ) : null}
          {deal.epicMobile ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">版本</dt>
              <dd className="text-right text-[var(--text)]">
                手游版 · {deal.mobilePlatforms.map((p) => (p === "android" ? "安卓" : "iOS")).join(" + ")}
                <span className="block text-xs text-[var(--dim2)]">与 PC 版是两个独立商品，别领错</span>
              </dd>
            </div>
          ) : null}
          {deal.regionLocked ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">地区</dt>
              <dd className="text-right font-medium text-[var(--warn)]">本周国区锁区，需外区 Epic 账号领取</dd>
            </div>
          ) : null}
        </dl>

        {intro ? (
          <section className="mt-6">
            <h2 className="font-serif text-[16px] font-bold text-[var(--text)]">{introHeading}</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-[1.7] text-[var(--dim)]">{intro}</p>
          </section>
        ) : null}

        {desc && desc !== intro ? (
          <section className="mt-6">
            <h2 className="font-serif text-[16px] font-bold text-[var(--text)]">简介</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-[1.7] text-[var(--dim)]">{desc}</p>
          </section>
        ) : null}

        {instructions ? (
          <section className="mt-6">
            <h2 className="font-serif text-[16px] font-bold text-[var(--text)]">领取方式</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-[1.7] text-[var(--dim)]">{instructions}</p>
          </section>
        ) : null}

        <div className="mt-8 grid gap-3">
          {deal.status === "upcoming" ? (
            <span className="rounded-[14px] bg-[var(--surface2)] px-4 py-3.5 text-center text-[15px] font-medium text-[var(--dim)]">未开始</span>
          ) : deal.claimUrl ? (
            <a
              href={deal.claimUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`去领取 ${mainTitle}`}
              className="cta-hard flex items-center justify-center gap-3 rounded-[14px] bg-grad px-4 py-[13px] text-center text-[15px] font-bold tracking-[0.04em] text-[var(--accent-ink)]"
            >
              去领取 <span aria-hidden="true" className="font-mono text-base">→</span>
            </a>
          ) : (
            <span className="rounded-[14px] bg-[var(--surface2)] px-4 py-3.5 text-center text-[15px] font-medium text-[var(--dim)]">
              {deal.source.includes("Epic") ? "Epic 商城领取" : "来源平台领取"}
            </span>
          )}
          {deal.gamePlatform === "prime" ? (
            <p className="text-center text-xs leading-relaxed text-[var(--dim2)]">领取需 Amazon Prime 会员 · 点「去领取」直达官方领取页，按标注渠道兑换入库</p>
          ) : null}
          {deal.status === "active" && purchaseMain ? (
            <>
              <p className="text-center text-xs leading-relaxed text-[var(--dim2)]">
                {mobileDeal
                  ? deal.epicOffers.length > 1
                    ? "「去领取」是 Epic 官方下单直达链接：一条链接带上安卓 + iOS 两端；只想领一端用下面两个按钮"
                    : "「去领取」是 Epic 官方下单直达链接"
                  : "「去领取」是 Epic 官方下单直达链接：打开即结算页，点「下订单」即领完"}
              </p>
              {mobileDeal ? (
                <p className="text-center text-xs font-medium leading-relaxed text-[var(--warn)]">{EPIC_MOBILE_HOP_NOTE}</p>
              ) : null}
              {mobileDeal && deal.epicOffers.length > 1 ? (
                <div className="flex gap-2.5">
                  {deal.epicOffers.map((o) => (
                    <a
                      key={o.platform}
                      href={o.purchaseUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`只领${o.platform === "android" ? "安卓" : "iOS"}版 ${mainTitle}`}
                      className="flex h-11 flex-1 items-center justify-center rounded-[14px] border border-[var(--border)] bg-[var(--surface)] text-sm font-bold text-[var(--text)] backdrop-blur-md"
                    >
                      只领{o.platform === "android" ? "安卓" : "iOS"}版
                    </a>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {(deal.gamePlatform === "epic" || purchaseMain) && deal.epicOffers.length > 0 && deal.epicOffers[0]?.productUrl ? (
            <a
              href={deal.epicOffers[0].productUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`查看商品页 ${mainTitle}`}
              className="text-center text-xs font-medium leading-relaxed text-[var(--accent)]"
            >
              打不开下单页？去 Epic 商品页领取 →
            </a>
          ) : null}
          {onQueueClaim && deal.status === "active" && deal.gamePlatform !== "prime" && (deal.tags.includes("game") || deal.tags.includes("dlc")) ? (
            deal.inLibrary ? (
              <span className="rounded-[14px] bg-[var(--free-bg)] px-4 py-3.5 text-center text-[15px] font-bold text-[var(--free-ink)]">已在游戏库</span>
            ) : (
              <button
                type="button"
                aria-label={`去官方领取 ${mainTitle}（排队验库）`}
                onClick={() => onQueueClaim(deal)}
                className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 text-center text-[15px] font-bold text-[var(--text)] backdrop-blur-md"
              >
                去官方领取（排队验库）
              </button>
            )
          ) : null}
          <div className="flex gap-2.5">
            <button type="button" aria-label={deal.saved ? `取消收藏 ${mainTitle}` : `收藏 ${mainTitle}`} aria-pressed={deal.saved} onClick={() => mark.mutate("saved")} className={toggleCls(deal.saved)}>
              {deal.saved ? "★ 已收藏" : "☆ 收藏"}
            </button>
            <button type="button" aria-label={deal.claimed ? `取消已领 ${mainTitle}` : `标记已领 ${mainTitle}`} aria-pressed={deal.claimed} onClick={() => mark.mutate("claimed")} className={toggleCls(deal.claimed)}>
              {deal.claimed ? "已领取" : "标记已领"}
            </button>
            <button
              type="button"
              aria-label={deal.hidden ? `取消不感兴趣 ${mainTitle}` : `标记不感兴趣 ${mainTitle}`}
              aria-pressed={deal.hidden}
              onClick={() => mark.mutate("hidden")}
              className={`h-11 flex-1 rounded-[14px] border text-sm font-medium backdrop-blur-md transition-colors ${deal.hidden ? "border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"}`}
            >
              {deal.hidden ? "恢复显示" : "不感兴趣"}
            </button>
          </div>
          {deal.isCustom ? (
            <button type="button" aria-label={`删除 ${mainTitle}`} disabled={del.isPending} onClick={() => del.mutate()} className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm font-medium text-[var(--warn)] disabled:opacity-50">
              {del.isPending ? "删除中…" : "删除这条"}
            </button>
          ) : null}
        </div>
      </div>

      {lightbox != null && deal.gallery[lightbox] ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label="截图大图">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="font-mono text-sm text-white/70">{lightbox + 1} / {deal.gallery.length}</span>
            <button type="button" aria-label="关闭大图" onClick={() => setLightbox(null)} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-base text-white">✕</button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-2">
            <SafeImg src={deal.gallery[lightbox]} alt={`${mainTitle} 官方截图 ${lightbox + 1}`} label={mainTitle} phFontSize={40} className="max-h-full max-w-full rounded-lg object-contain" />
          </div>
          {deal.gallery.length > 1 ? (
            <div className="flex items-center justify-center gap-3 py-5">
              <button type="button" aria-label="上一张截图" onClick={() => setLightbox((lightbox - 1 + deal.gallery.length) % deal.gallery.length)} className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl text-white">‹</button>
              <button type="button" aria-label="下一张截图" onClick={() => setLightbox((lightbox + 1) % deal.gallery.length)} className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl text-white">›</button>
            </div>
          ) : (
            <div className="py-5" />
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------- add form ----------

function AddForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<"game" | "ios" | "cloud" | "ai" | "dlc" | "other">("other");
  const [url, setUrl] = useState("");
  const [worth, setWorth] = useState("");
  const [endDate, setEndDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.addCustomDeal({
        title: title.trim(),
        category,
        claimUrl: url.trim() ? url.trim() : undefined,
        worthCents: worth.trim() ? Math.round(parseFloat(worth) * 100) : null,
        endDate: endDate ? endDate : null,
        note: note.trim() ? note.trim() : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "添加失败"),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("先填个标题");
      return;
    }
    if (url.trim() && !/^https?:\/\//i.test(url.trim())) {
      setError("链接要以 http:// 或 https:// 开头");
      return;
    }
    add.mutate();
  }

  const inputCls = "w-full rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm text-[var(--text)] outline-none backdrop-blur-md focus:border-[var(--accent)]";
  return (
    <form onSubmit={submit} className="rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-5">
      <h2 className="font-serif text-base font-bold text-[var(--text)]">添加羊毛</h2>
      <div className="mt-4 grid gap-3.5">
        <div>
          <label htmlFor="add-title" className="text-xs font-medium text-[var(--dim)]">标题 *</label>
          <input id="add-title" aria-label="标题" className={`${inputCls} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：某某云新用户免费 3 个月" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="add-cat" className="text-xs font-medium text-[var(--dim)]">分类</label>
            <select id="add-cat" aria-label="分类" className={`${inputCls} mt-1`} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              <option value="game">游戏</option>
              <option value="ios">iOS 应用</option>
              <option value="cloud">云服务</option>
              <option value="ai">AI 额度</option>
              <option value="dlc">DLC / 道具</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label htmlFor="add-worth" className="text-xs font-medium text-[var(--dim)]">原价（美元，可空）</label>
            <input id="add-worth" aria-label="原价美元" className={`${inputCls} mt-1`} inputMode="decimal" value={worth} onChange={(e) => setWorth(e.target.value)} placeholder="如 9.99" />
          </div>
        </div>
        <div>
          <label htmlFor="add-url" className="text-xs font-medium text-[var(--dim)]">领取链接</label>
          <input id="add-url" aria-label="领取链接" className={`${inputCls} mt-1`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="add-end" className="text-xs font-medium text-[var(--dim)]">截止日期（可空）</label>
            <input id="add-end" aria-label="截止日期" type="date" className={`${inputCls} mt-1`} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="add-note" className="text-xs font-medium text-[var(--dim)]">备注</label>
            <input id="add-note" aria-label="备注" className={`${inputCls} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="领取条件、注意事项…" />
          </div>
        </div>
        {error ? <p className="text-xs font-medium text-[var(--warn)]">{error}</p> : null}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={add.isPending} className="flex-1 rounded-[14px] bg-grad px-3 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50">
            {add.isPending ? "添加中…" : "添加"}
          </button>
          <button type="button" onClick={onDone} className="border border-[var(--border)] px-5 py-2.5 text-sm font-medium text-[var(--dim)]">取消</button>
        </div>
      </div>
    </form>
  );
}

// ---------- today page (masthead / brief / inner tabs) ----------

function InnerTabs({
  tab,
  setTab,
  counts,
}: {
  tab: InnerTab;
  setTab: (t: InnerTab) => void;
  counts: { today: number; all: number; claimed: number };
}) {
  const defs: { key: InnerTab; label: string; count: number }[] = [
    { key: "today", label: "今日可领", count: counts.today },
    { key: "all", label: "全部羊毛", count: counts.all },
    { key: "claimed", label: "已领取", count: counts.claimed },
  ];
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [ink, setInk] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const idx = defs.findIndex((d) => d.key === tab);
    const el = btnRefs.current[idx];
    if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, counts.today, counts.all, counts.claimed]);
  return (
    <nav aria-label="今日页选项卡" className="relative flex gap-[22px] border-b border-[var(--border)]">
      {defs.map((d, i) => (
        <button
          key={d.key}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          type="button"
          aria-pressed={tab === d.key}
          aria-label={`${d.label}，共 ${d.count} 条`}
          onClick={() => setTab(d.key)}
          className={`relative whitespace-nowrap pb-[13px] text-[13px] leading-none transition-colors ${tab === d.key ? "font-bold text-[var(--text)]" : "font-medium text-[var(--dim2)]"}`}
        >
          {d.label}
          <em className={`ml-[5px] font-mono text-[10px] not-italic ${tab === d.key ? "text-[var(--accent)]" : "text-[var(--dim2)]"}`}>{d.count}</em>
        </button>
      ))}
      <span
        aria-hidden="true"
        className="absolute -bottom-px left-0 h-[2.5px] bg-grad transition-all duration-300"
        style={{ width: ink.width, transform: `translateX(${ink.left}px)` }}
      />
    </nav>
  );
}

type TodayProps = {
  deals: Deal[];
  now: number;
  onOpen: (d: Deal) => void;
  innerTab: InnerTab;
  setInnerTab: (t: InnerTab) => void;
  onlySaved: boolean;
  setOnlySaved: (v: boolean | ((p: boolean) => boolean)) => void;
  showAdd: boolean;
  setShowAdd: (v: boolean | ((p: boolean) => boolean)) => void;
  hideClaimed: boolean;
  setHideClaimed: (v: boolean) => void;
  hideHidden: boolean;
  setHideHidden: (v: boolean) => void;
  authToken?: string;
  theme: UiTheme;
  onToggleTheme: () => void;
};

function TodayPage(p: TodayProps) {
  const queryClient = useQueryClient();
  const [unclaimedOnly, setUnclaimedOnly] = useState(false);
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [sort, setSort] = useState<SortKey>("expiry");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const refresh = useMutation({
    mutationFn: () => api.refreshDeals({}),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["appPrices"] });
      setRefreshMsg(`已同步：GamerPower ${r.gamerpowerCount} 条 · Epic ${r.epicCount} 条 · iOS 限免 ${r.iosFreeCount} 条${r.errors.length ? ` · ${r.errors.join("；")}` : ""}`);
    },
    onError: (e) => setRefreshMsg(`同步失败：${e instanceof Error ? e.message : String(e)}`),
  });
  const clearHidden = useMutation({
    mutationFn: () => api.clearHiddenMarks({ authToken: p.authToken }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deals"] }),
  });

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [category, deferredSearch, sort, p.onlySaved, p.hideClaimed, p.hideHidden]);

  const { deals, now } = p;
  const hiddenCount = useMemo(() => deals.filter((d) => d.hidden).length, [deals]);
  const claimedCount = useMemo(() => deals.filter((d) => d.claimed).length, [deals]);

  const applyHide = useMemo(
    () => (list: Deal[]) => list.filter((d) => (!p.hideClaimed || !d.claimed) && (!p.hideHidden || !d.hidden)),
    [p.hideClaimed, p.hideHidden],
  );

  const focus = useMemo(() => {
    const pool = applyHide(deals);
    const active = pool.filter((d) => d.status === "active");
    const epicActive = active.filter((d) => d.externalId.startsWith("epic-"));
    const todayRef = new Date(now);
    const expiringSoon = active
      .filter((d) => !d.externalId.startsWith("epic-") && endsWithin(d.endAt, now, 48))
      .sort((a, b) => new Date(a.endAt ?? 0).getTime() - new Date(b.endAt ?? 0).getTime());
    const publishedToday = active
      .filter((d) => !d.externalId.startsWith("epic-") && isSameLocalDay(d.publishedAt, todayRef))
      .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime());
    const latest = [...active]
      .filter((d) => !d.externalId.startsWith("epic-"))
      .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime())
      .slice(0, 6);
    const ordered: Deal[] = [];
    const seen = new Set<number>();
    for (const d of [...epicActive, ...expiringSoon.slice(0, 8), ...(publishedToday.length ? publishedToday.slice(0, 8) : latest)]) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      ordered.push(d);
    }
    const upcoming = pool.filter((d) => d.externalId.startsWith("epic-") && d.status === "upcoming");
    return { ordered, upcoming };
  }, [deals, now, applyHide]);

  const visibleFocus = useMemo(
    () => (unclaimedOnly ? focus.ordered.filter((d) => !d.claimed) : focus.ordered),
    [focus, unclaimedOnly],
  );
  const focusClaimed = useMemo(() => focus.ordered.filter((d) => d.claimed).length, [focus]);
  const hero = visibleFocus[0] ?? null;
  const restFocus = visibleFocus.slice(1);

  const visibleAll = useMemo(() => {
    let list = [...deals];
    if (category !== "all") list = list.filter((d) => d.tags.includes(category));
    if (p.onlySaved) list = list.filter((d) => d.saved);
    list = applyHide(list);
    const q = deferredSearch.trim().toLowerCase();
    if (q) list = list.filter((d) => `${d.title} ${d.titleZh ?? ""} ${d.description} ${d.descriptionZh ?? ""} ${d.platform} ${platformZh(d.platform)} ${d.source}`.toLowerCase().includes(q));
    if (sort === "expiry") {
      list.sort((a, b) => {
        if (!a.endAt && !b.endAt) return 0;
        if (!a.endAt) return 1;
        if (!b.endAt) return -1;
        return new Date(a.endAt).getTime() - new Date(b.endAt).getTime();
      });
    } else if (sort === "newest") {
      list.sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime());
    } else {
      list.sort((a, b) => (b.worthCents ?? 0) - (a.worthCents ?? 0));
    }
    return list;
  }, [deals, category, p.onlySaved, applyHide, deferredSearch, sort]);

  const pagedAll = useMemo(() => visibleAll.slice(0, visibleCount), [visibleAll, visibleCount]);

  const claimedList = useMemo(
    () =>
      deals
        .filter((d) => d.claimed && (!p.hideHidden || !d.hidden))
        .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()),
    [deals, p.hideHidden],
  );

  const todayDate = new Date(now);
  const dayOfYear = Math.floor((Date.UTC(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate()) - Date.UTC(todayDate.getFullYear(), 0, 0)) / 86400000);
  const weekEn = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][todayDate.getDay()] ?? "";
  const dateLine = `${todayDate.getFullYear()}.${String(todayDate.getMonth() + 1).padStart(2, "0")}.${String(todayDate.getDate()).padStart(2, "0")} / ${weekEn}`;
  const filtersOn = unclaimedOnly || p.hideClaimed || p.hideHidden;
  const resetFilters = () => {
    setUnclaimedOnly(false);
    p.setHideClaimed(false);
    p.setHideHidden(false);
  };

  return (
    <div>
      {/* masthead */}
      <header>
        <div className="flex items-center justify-between pb-2.5 pt-3.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.12em] text-[var(--dim2)]">
          <span>
            VOL.{String(dayOfYear).padStart(3, "0")} <span className="text-[var(--accent)]">●</span> 每日限免情报
          </span>
          <span>{dateLine}</span>
        </div>
        <div className="flex items-end justify-between gap-2.5">
          <div className="flex flex-wrap items-baseline gap-[9px]">
            <h1 className="grad-text relative font-serif text-[34px] font-semibold leading-none tracking-[0.04em]">
              羊毛日报
              <span aria-hidden="true" className="absolute -right-[15px] top-[2px] h-[9px] w-[9px] rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent)]" />
            </h1>
            <span className="whitespace-nowrap font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--dim2)]">FREE GAME DAILY</span>
          </div>
          <div className="relative flex gap-2 pb-[3px]">
            <ThemeToggleButton theme={p.theme} onToggle={p.onToggleTheme} />
            <button
              type="button"
              aria-label="刷新同步"
              title="刷新同步"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              className="grid h-[34px] w-[34px] place-items-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.1" /><path d="M20 4v7h-7" /></svg>
            </button>
            <button
              type="button"
              aria-label="更多操作"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="grid h-[34px] w-[34px] place-items-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
            </button>
            {menuOpen ? (
              <div className="absolute right-0 top-[42px] z-20 w-44 rounded-[14px] border border-[var(--glass-edge)] bg-[var(--chrome-bg-strong)] py-1.5 shadow-[var(--shadow)] backdrop-blur-xl" role="menu" aria-label="更多操作菜单">
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-4 py-2.5 text-left text-[13px] text-[var(--text)]"
                  onClick={() => {
                    setMenuOpen(false);
                    p.setInnerTab("all");
                    p.setShowAdd(true);
                  }}
                >
                  ＋ 添加羊毛
                </button>
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={clearHidden.isPending}
                    className="block w-full px-4 py-2.5 text-left text-[13px] text-[var(--text)] disabled:opacity-50"
                    onClick={() => {
                      clearHidden.mutate();
                      setMenuOpen(false);
                    }}
                  >
                    恢复全部不感兴趣（{hiddenCount}）
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-4 py-2.5 text-left text-[13px] text-[var(--text)]"
                  onClick={() => {
                    setMenuOpen(false);
                    p.setInnerTab("claimed");
                  }}
                >
                  查看已领取（{claimedCount}）
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="double-rule mt-4" aria-hidden="true" />
        <div className="flex justify-between pt-1.5 font-mono text-[9px] font-medium uppercase leading-none tracking-[0.16em] text-[var(--dim2)]">
          <span>今日战报 / TODAY'S BRIEF</span>
          <span>{refreshMsg ?? ""}</span>
        </div>
      </header>

      {/* brief */}
      <section aria-label="今日战报" className="flex items-center gap-4 pb-[18px] pt-5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="grad-text font-num text-[58px] font-light leading-[0.82]">{String(focus.ordered.length).padStart(2, "0")}</span>
          <span>
            <b className="mb-1 block text-[13px] font-bold leading-[1.3] text-[var(--text)]">今日可领</b>
            <span className="block whitespace-nowrap font-mono text-[10px] leading-[1.4] text-[var(--dim2)]">待领 {focus.ordered.length - focusClaimed} 款</span>
          </span>
        </div>
        <div aria-hidden="true" className="h-[42px] w-px flex-none bg-[var(--border)]" />
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="grad-text-mint font-num text-[58px] font-light leading-[0.82]">{deals.length}</span>
          <span>
            <b className="mb-1 block text-[13px] font-bold leading-[1.3] text-[var(--text)]">全部羊毛</b>
            <span className="block whitespace-nowrap font-mono text-[10px] leading-[1.4] text-[var(--dim2)]">持续收录中</span>
          </span>
        </div>
      </section>
      <div className="relative mb-[18px] h-1 overflow-hidden rounded-full bg-[var(--seg-track)]" role="progressbar" aria-label="今日领取进度" aria-valuenow={focusClaimed} aria-valuemax={Math.max(1, focus.ordered.length)}>
        <i className="absolute inset-y-0 left-0 bg-grad transition-all duration-500" style={{ width: `${focus.ordered.length ? (focusClaimed / focus.ordered.length) * 100 : 0}%` }} />
      </div>
      <div className="-mt-3 mb-5 flex justify-between font-mono text-[9.5px] font-medium uppercase leading-none tracking-[0.1em] text-[var(--dim2)]">
        <span>领取进度 / CLAIMED</span>
        <em className="not-italic text-[var(--accent)]">{focusClaimed} / {focus.ordered.length}</em>
      </div>

      <InnerTabs tab={p.innerTab} setTab={p.setInnerTab} counts={{ today: focus.ordered.length, all: deals.length, claimed: claimedCount }} />

      {p.innerTab !== "claimed" ? (
        <ChipsRow label="筛选">
          <Chip active={!filtersOn} onClick={resetFilters} label="全部" ariaLabel="显示全部（清除筛选）" />
          <Chip active={unclaimedOnly} onClick={() => setUnclaimedOnly((v) => !v)} label="未领取" ariaLabel="只看未领取" />
          <Chip active={p.hideClaimed} onClick={() => p.setHideClaimed(!p.hideClaimed)} label="隐藏已领" count={claimedCount} ariaLabel="隐藏已领取" />
          <Chip active={p.hideHidden} onClick={() => p.setHideHidden(!p.hideHidden)} label="不感兴趣" count={hiddenCount} ariaLabel="隐藏不感兴趣" />
          <button type="button" aria-label="重置筛选" onClick={resetFilters} className="flex flex-none items-center gap-1 whitespace-nowrap px-1.5 font-mono text-[10px] font-medium tracking-[0.06em] text-[var(--dim2)]">
            <span aria-hidden="true" className="text-[13px]">↺</span> 重置
          </button>
          {p.innerTab === "all" ? (
            <button
              type="button"
              aria-expanded={p.showAdd}
              aria-label="添加一条羊毛"
              onClick={() => p.setShowAdd(!p.showAdd)}
              className={`flex-none whitespace-nowrap rounded-full border px-3 py-[7px] text-[11px] font-medium leading-none ${p.showAdd ? "border-transparent bg-grad font-bold text-[var(--accent-ink)]" : "border-[var(--border)] bg-[var(--surface2)] text-[var(--dim)]"}`}
            >
              ＋ 添加羊毛
            </button>
          ) : null}
        </ChipsRow>
      ) : null}

      {p.innerTab === "today" ? (
        <>
          {hero ? (
            <>
              <SectionHead no="01" title="今日主推" en="EDITOR'S PICK" />
              <HeroCard deal={hero} now={now} onOpen={p.onOpen} />
            </>
          ) : null}
          <SectionHead no="02" title="最近上新" en="NEW ARRIVALS" />
          {restFocus.length > 0 ? (
            <div className="flex flex-col gap-[9px]">
              {restFocus.map((d) => (
                <MiniRow key={d.id} deal={d} now={now} onOpen={p.onOpen} />
              ))}
            </div>
          ) : hero ? null : (
            <EmptyNote title="今日暂无可领" sub="换个筛选条件，或到「全部羊毛」里看看。" />
          )}
          {focus.upcoming.length > 0 ? (
            <>
              <SectionHead no="03" title="下期预告" en="COMING UP" />
              <div className="flex flex-col gap-[9px]">
                {focus.upcoming.map((d) => (
                  <MiniRow key={d.id} deal={d} now={now} onOpen={p.onOpen} />
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : p.innerTab === "all" ? (
        <>
          <div className="flex flex-wrap gap-[7px] pt-3" role="group" aria-label="分类筛选">
            {CATEGORIES.map((c) => (
              <Chip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)} label={c.label} ariaLabel={`分类 ${c.label}`} />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              aria-label="搜索羊毛"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索"
              className="min-w-0 flex-1 rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none backdrop-blur-md focus:border-[var(--accent)]"
            />
            <select aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="shrink-0 rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-2.5 py-2.5 text-[13px] font-medium text-[var(--text)] backdrop-blur-md">
              <option value="expiry">即将过期</option>
              <option value="newest">最新发布</option>
              <option value="worth">价值最高</option>
            </select>
            <Chip active={p.onlySaved} onClick={() => p.setOnlySaved(!p.onlySaved)} label="只看收藏" ariaLabel="只看我的收藏" />
          </div>
          {p.showAdd ? (
            <div className="mt-4">
              <AddForm onDone={() => p.setShowAdd(false)} />
            </div>
          ) : null}
          <div className="mt-5">
            {visibleAll.length === 0 ? (
              <EmptyNote
                title="没有符合条件的条目"
                sub={p.hideClaimed || p.hideHidden ? "有些条目被隐藏开关挡住了。" : undefined}
              />
            ) : (
              <>
                <div className="flex flex-col gap-[9px]">
                  {pagedAll.map((d) => (
                    <MiniRow key={d.id} deal={d} now={now} onOpen={p.onOpen} />
                  ))}
                </div>
                {visibleAll.length > pagedAll.length ? (
                  <button type="button" aria-label="加载更多羊毛" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)} className="mt-4 w-full rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm font-medium text-[var(--text)] backdrop-blur-md">
                    加载更多（还剩 {visibleAll.length - pagedAll.length} 条）
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      ) : (
        <div className="mt-5">
          {claimedList.length === 0 ? (
            <EmptyNote title="还没有领取记录" sub="在详情页点「标记已领」后会出现在这里。" />
          ) : (
            <div className="flex flex-col gap-[9px]">
              {claimedList.map((d) => (
                <MiniRow key={d.id} deal={d} now={now} onOpen={p.onOpen} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-8 flex justify-between border-t border-[var(--border)] pt-3 font-mono text-[9px] font-medium uppercase leading-none tracking-[0.16em] text-[var(--dim2)]">
        <span>END OF ISSUE · VOL.{String(dayOfYear).padStart(3, "0")}</span>
        <span>每日更新</span>
      </div>
    </div>
  );
}

// ---------- apps page ----------

function PriceRow({ app, deal, onOpenDeal }: { app: AppPrice; deal: Deal | null; onOpenDeal: (d: Deal) => void }) {
  const inner = (
    <>
      {app.iconUrl ? (
        <SafeImg src={app.iconUrl} alt="" label={app.name} phFontSize={22} className="h-[54px] w-[54px] flex-none rounded-[12px] border border-[var(--border)] bg-[var(--surface2)] object-cover" loading="lazy" decoding="async" />
      ) : (
        <div aria-hidden="true" className="flex h-[54px] w-[54px] flex-none items-center justify-center rounded-[12px] bg-[var(--surface2)] font-serif text-xl font-bold text-[var(--dim)]">
          {(app.name.trim()[0] ?? "A").toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-[13px] font-bold leading-[1.3] text-[var(--text)]">{app.name}</h4>
        <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.03em] text-[var(--dim2)]">APP STORE · 美区价格</p>
        <div className="mt-1.5 flex items-baseline gap-[7px]">
          <b className={`text-xs font-bold ${app.currentCents === 0 ? "text-[var(--free-ink)]" : "text-[var(--text)]"}`}>{priceText(app.currentCents, app.currency)}</b>
          {app.isDrop ? (
            <>
              <s className="font-mono text-[10px] text-[var(--dim2)]">{priceText(app.wasCents, app.currency)}</s>
              <span className="font-mono text-[10px] font-semibold text-[var(--accent)]">-{app.dropPct}%</span>
            </>
          ) : (
            <span className="font-mono text-[9.5px] text-[var(--dim2)]">自 {app.firstSnapshotDate} 起记录</span>
          )}
        </div>
      </div>
      <span aria-hidden="true" className="flex-none font-mono text-sm text-[var(--dim2)]">→</span>
    </>
  );
  const cls = "flex w-full items-center gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-[9px] text-left shadow-[var(--glass-hi)] backdrop-blur-md";
  if (deal) {
    return (
      <button type="button" aria-label={`查看详情：${app.name}`} onClick={() => onOpenDeal(deal)} className={cls}>
        {inner}
      </button>
    );
  }
  if (app.storeUrl) {
    return (
      <a href={app.storeUrl} target="_blank" rel="noreferrer" aria-label={`在 App Store 打开 ${app.name}`} className={cls}>
        {inner}
      </a>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function AppsPage({ deals, now, onOpen, hideClaimed, hideHidden }: { deals: Deal[]; now: number; onOpen: (d: Deal) => void; hideClaimed: boolean; hideHidden: boolean }) {
  const [chip, setChip] = useState<"all" | "free" | "drop">("all");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  // 记住用户选择的 App Store 区服（本设备）。默认国区。
  const [region, setRegion] = useState<string>(() => {
    try {
      const saved = localStorage.getItem("fgame-ios-region");
      if (saved && IOS_REGION_TABS.some((t) => t.code === saved)) return saved;
    } catch { /* ignore */ }
    return "cn";
  });
  const changeRegion = (code: string) => {
    setRegion(code);
    try { localStorage.setItem("fgame-ios-region", code); } catch { /* ignore */ }
  };
  const pricesQuery = useQuery({ queryKey: ["appPrices"], queryFn: () => api.listAppPrices({}) });

  const q = deferredSearch.trim().toLowerCase();
  const activeTab = IOS_REGION_TABS.find((t) => t.code === region) ?? IOS_REGION_TABS[1]!;

  // 把某区服下可见的 iOS 限免条目取出，并把领取链接换成该区 App Store。
  // 旧数据（regions 为空）按「国区」兜底，保持兼容。
  const regionFree = useMemo(() => {
    return deals
      .filter((d) => {
        if (!d.appStore || d.status !== "active") return false;
        const codes = d.regions && d.regions.length ? d.regions : ["cn"];
        if (region === "all") return true;
        return codes.includes(region);
      })
      .map((d) => {
        if (region === "all" || !d.claimUrl) return d;
        const swapped = d.claimUrl.replace(
          /(apps\.apple\.com\/)([a-z]{2})(\/)/i,
          (_m, a, _cc, c) => `${a}${activeTab.cc}${c}`,
        );
        return { ...d, claimUrl: swapped };
      });
  }, [deals, region, activeTab.cc]);

  const freeApps = useMemo(
    () =>
      regionFree.filter(
        (d) =>
          (!hideClaimed || !d.claimed) &&
          (!hideHidden || !d.hidden) &&
          (!q || `${d.title} ${d.titleZh ?? ""}`.toLowerCase().includes(q)),
      ),
    [regionFree, hideClaimed, hideHidden, q],
  );
  const apps = pricesQuery.data?.apps ?? [];
  const drops = apps.filter((a) => a.isDrop && (!q || a.name.toLowerCase().includes(q)));
  const dealById = useMemo(() => new Map(deals.map((d) => [d.id, d])), [deals]);

  return (
    <div>
      <div className="flex items-baseline gap-2 pb-1 pt-4">
        <h1 className="font-serif text-[26px] font-black leading-none text-[var(--text)]">应用</h1>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--dim2)]">iOS APPS</span>
      </div>
      <ChipsRow label="应用筛选">
        <Chip active={chip === "all"} onClick={() => setChip("all")} label="全部" ariaLabel="全部应用" />
        <Chip active={chip === "free"} onClick={() => setChip("free")} label="限免" count={freeApps.length} ariaLabel="只看限免应用" />
        <Chip active={chip === "drop"} onClick={() => setChip("drop")} label="降价" count={drops.length} ariaLabel="只看降价应用" />
      </ChipsRow>
      <input
        aria-label="搜索应用"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="搜索应用"
        className="mt-2 w-full rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none backdrop-blur-md focus:border-[var(--accent)]"
      />

      {chip !== "drop" ? (
        <>
          {/* 区服切换：国 / 美 / 日 / 印度 / 港，按 Apple 官方逐区核验结果推荐 */}
          <div className="mt-3 flex items-center gap-2">
            <span className="flex-none font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--dim2)]">区服</span>
            <div className="-mx-1 flex flex-1 gap-[6px] overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {IOS_REGION_TABS.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  aria-pressed={region === t.code}
                  onClick={() => changeRegion(t.code)}
                  className={`flex-none whitespace-nowrap rounded-full border px-2.5 py-[5px] text-[10.5px] font-medium leading-none transition-colors ${
                    region === t.code
                      ? "border-transparent bg-grad font-bold text-[var(--accent-ink)]"
                      : "border-[var(--border)] bg-[var(--surface2)] text-[var(--dim)]"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 font-mono text-[9px] leading-[1.5] text-[var(--dim2)]">
            {region === "all"
              ? "展示全部区服已核验的限免 · 徽标标注该应用可用的区服"
              : `仅显示在${activeTab.label} App Store 官方核验为 ¥0 的限免 · 需切换到该区账号领取`}
          </p>

          <SectionHead
            no="01"
            title="iOS 限免"
            en={region === "all" ? "FREE · ALL REGIONS" : `FREE · ${activeTab.label.toUpperCase()}`}
          />
          {freeApps.length > 0 ? (
            <div className="flex flex-col gap-[9px]">
              {freeApps.map((d) => {
                const codes = d.regions && d.regions.length ? d.regions : ["cn"];
                const badge = codes.map((c) => IOS_REGION_LABEL[c] ?? c).join("·");
                return <MiniRow key={d.id} deal={d} now={now} onOpen={onOpen} badge={badge} />;
              })}
            </div>
          ) : (
            <EmptyNote
              title={region === "all" ? "暂无限免应用" : `${activeTab.label}暂无限免应用`}
              sub={region === "all" ? "本页只收录 App Store 限免，确认上架的才会出现在这里。" : "换一个区服看看，或点上方「全部区服」。每条限免都经该区 App Store 官方价格核验。"}
            />
          )}
        </>
      ) : null}

      {chip !== "free" ? (
        <>
          <SectionHead no="02" title="降价" en="PRICE DROPS" />
          {pricesQuery.isPending ? (
            <p className="py-8 text-center text-sm text-[var(--dim)]">加载中…</p>
          ) : drops.length > 0 ? (
            <div className="flex flex-col gap-[9px]">
              {drops.map((a) => (
                <PriceRow key={a.trackId} app={a} deal={a.dealId != null ? (dealById.get(a.dealId) ?? null) : null} onOpenDeal={onOpen} />
              ))}
            </div>
          ) : (
            <EmptyNote title="暂无真实降价" sub="价格每天记录一次快照，现价低于记录到的历史价才会出现在这里。" />
          )}
        </>
      ) : null}
    </div>
  );
}

function GamesPage({
  deals,
  now,
  onOpen,
  hideClaimed,
  hideHidden,
  onOpenPrimeClaim,
  session,
  onNeedLogin,
  onOpenBatchClaim,
}: {
  deals: Deal[];
  now: number;
  onOpen: (d: Deal) => void;
  hideClaimed: boolean;
  hideHidden: boolean;
  onOpenPrimeClaim: () => void;
  session: Session | null;
  onNeedLogin: () => void;
  onOpenBatchClaim: (items: Deal[]) => void;
}) {
  const [plat, setPlat] = useState<string>("all");
  // 长按多选：selecting 为多选模式开关，selOrder 按选中先后记条目 id
  // （队列就按这个顺序逐款领取）；状态挂在页面组件上，切平台 chip 不丢。
  const [selecting, setSelecting] = useState(false);
  const [selOrder, setSelOrder] = useState<number[]>([]);
  const exitSelecting = () => {
    setSelecting(false);
    setSelOrder([]);
  };
  const toggleSelect = (d: Deal) => {
    setSelOrder((prev) => (prev.includes(d.id) ? prev.filter((x) => x !== d.id) : [...prev, d.id]));
  };
  const handleLongPress = (d: Deal) => {
    if (selecting) {
      exitSelecting();
    } else {
      setSelecting(true);
      setSelOrder(d.inLibrary ? [] : [d.id]);
    }
  };
  const primeUnclaimed = useMemo(
    () => deals.filter((d) => d.gamePlatform === "prime" && d.status === "active" && !d.claimed).length,
    [deals],
  );
  const list = useMemo(
    () =>
      deals
        .filter(
          (d) =>
            (d.tags.includes("game") || d.tags.includes("dlc")) &&
            // "epic" 分栏只放 PC 版 Epic 限免；手游版有自己的 chip，
            // 并在 全部 / Epic 视图里以「Epic 手游」子区单独出现 —
            // 同名 PC 版与手游版永远分开，不合并。
            (plat === "all"
              ? true
              : plat === "epic-mobile"
                ? d.epicMobile
                : plat === "epic"
                  ? d.gamePlatform === "epic" && !d.epicMobile
                  : d.gamePlatform === plat) &&
            (!hideClaimed || !d.claimed) &&
            (!hideHidden || !d.hidden),
        )
        .sort((a, b) => {
          if (plat === "prime") {
            // Prime 会员游戏：可领的按领取截止日从近到远，未上线的排最后按上线日。
            const au = a.status === "upcoming" ? 1 : 0;
            const bu = b.status === "upcoming" ? 1 : 0;
            if (au !== bu) return au - bu;
            if (au === 1) {
              return new Date(a.publishedAt ?? 0).getTime() - new Date(b.publishedAt ?? 0).getTime();
            }
            if (!a.endAt && !b.endAt) return 0;
            if (!a.endAt) return 1;
            if (!b.endAt) return -1;
            return new Date(a.endAt).getTime() - new Date(b.endAt).getTime();
          }
          if (!a.endAt && !b.endAt) return 0;
          if (!a.endAt) return 1;
          if (!b.endAt) return -1;
          return new Date(a.endAt).getTime() - new Date(b.endAt).getTime();
        }),
    [deals, plat, hideClaimed, hideHidden],
  );
  const visibleSelectable = useMemo(() => list.filter((d) => !d.inLibrary), [list]);
  const selectAllVisible = () => {
    setSelOrder((prev) => {
      const next = [...prev];
      for (const d of visibleSelectable) {
        if (!next.includes(d.id)) next.push(d.id);
      }
      return next;
    });
  };
  const startClaim = () => {
    if (!session) {
      // 未登录站内账号：先去「我的」登录，绑定与验库都记在账号名下
      onNeedLogin();
      return;
    }
    const chosen = selOrder
      .map((id) => deals.find((d) => d.id === id))
      .filter((d): d is Deal => !!d);
    if (chosen.length === 0) return;
    exitSelecting();
    onOpenBatchClaim(chosen);
  };
  return (
    <div>
      <div className="flex items-baseline gap-2 pb-1 pt-4">
        <h1 className="font-serif text-[26px] font-black leading-none text-[var(--text)]">游戏</h1>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--dim2)]">GAME GIVEAWAYS</span>
        {!selecting ? (
          <button
            type="button"
            aria-label="批量入库：进入多选模式"
            onClick={() => setSelecting(true)}
            className="ml-auto flex-none self-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] px-3 py-1.5 text-xs font-bold text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md"
          >
            批量入库
          </button>
        ) : null}
      </div>
      {selecting ? (
        <p className="pb-1 text-xs leading-relaxed text-[var(--dim)]">多选模式：点游戏切换选中，已入库的不可选；选好后点下方「一键入库」，逐款在官方页领取。</p>
      ) : null}
      <ChipsRow label="游戏平台筛选">
        {GAME_PLATFORMS.map((g) => (
          <Chip key={g.key} active={plat === g.key} onClick={() => setPlat(g.key)} label={g.label} ariaLabel={`游戏平台 ${g.label}`} />
        ))}
      </ChipsRow>
      {plat === "prime" ? (
        <section className="mt-4 flex items-center gap-3 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-[15px] font-bold leading-tight text-[var(--text)]">一键领取 Prime 游戏</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
              {primeUnclaimed > 0 ? `${primeUnclaimed} 款未领，按截止日排队逐款领` : "当前没有未领的 Prime 游戏"}
            </p>
          </div>
          <button
            type="button"
            aria-label="打开 Prime 一键领取队列"
            onClick={onOpenPrimeClaim}
            className="cta-hard flex-none bg-grad px-4 py-2.5 text-[13px] font-bold text-[var(--accent-ink)]"
          >
            一键领取
          </button>
        </section>
      ) : null}
      <div className="mt-4">
        {plat === "prime" ? <SectionHead no="01" title="Prime 会员游戏" en="INCLUDED WITH PRIME" /> : null}
        {list.length > 0 ? (
          <>
            {(() => {
              // Epic 手游单独成区：在 全部 / Epic 视图里排在 PC 条目
              // 之后、带自己的小节标题；在 Epic 手游 chip 下直接平铺。
              const splitMobile = plat === "all" || plat === "epic";
              const mainRows = splitMobile ? list.filter((d) => !d.epicMobile) : list;
              const mobileRows = splitMobile ? list.filter((d) => d.epicMobile) : [];
              const row = (d: Deal) => (
                <SelectableGameRow
                  key={d.id}
                  deal={d}
                  now={now}
                  selecting={selecting}
                  selected={selOrder.includes(d.id)}
                  onOpen={onOpen}
                  onToggle={toggleSelect}
                  onLongPressFire={handleLongPress}
                />
              );
              return (
                <>
                  {mainRows.length > 0 ? <div className="flex flex-col gap-[9px]">{mainRows.map(row)}</div> : null}
                  {mobileRows.length > 0 ? (
                    <div className={mainRows.length > 0 ? "mt-6" : ""}>
                      <SectionHead no="手游" title="Epic 手游" en="EPIC MOBILE · 每周限免" />
                      <div className="flex flex-col gap-[9px]">{mobileRows.map(row)}</div>
                    </div>
                  ) : null}
                </>
              );
            })()}
          </>
        ) : (
          <EmptyNote title="这个平台暂时没有限免" sub="每日同步会按平台补齐 Epic / Steam / GOG 的赠送；Prime 会员游戏按官方领取截止日收录，过截止日的自动下架。" />
        )}
      </div>
      {selecting ? (
        <>
          <div className="h-28" aria-hidden="true" />
          <div className="fixed inset-x-0 z-30" style={{ bottom: "calc(62px + env(safe-area-inset-bottom, 0px))" }}>
            <div className="mx-auto w-full max-w-3xl px-[22px]">
              <div className="flex items-center gap-2 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--chrome-bg-strong)] p-2.5 shadow-[var(--shadow)] backdrop-blur-[18px]">
                <span className="flex-none pl-1.5 text-[13px] font-bold text-[var(--text)]" aria-live="polite">
                  已选 {selOrder.length} 款
                </span>
                <button
                  type="button"
                  aria-label="全选当前筛选列表"
                  disabled={visibleSelectable.length === 0}
                  onClick={selectAllVisible}
                  className="flex-none rounded-full border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--text)] disabled:opacity-40"
                >
                  全选
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label="退出多选模式"
                  onClick={exitSelecting}
                  className="flex-none rounded-full border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--dim)]"
                >
                  退出
                </button>
                <button
                  type="button"
                  aria-label="一键入库：打开官方领取队列"
                  disabled={selOrder.length === 0}
                  onClick={startClaim}
                  className="cta-hard flex-none rounded-full bg-grad px-4 py-2 text-[13px] font-bold text-[var(--accent-ink)] disabled:opacity-40"
                >
                  一键入库
                </button>
              </div>
              <p className="mt-1.5 text-center text-[10.5px] leading-relaxed text-[var(--dim2)]">在官方页领取，空间负责排队与同步验库</p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------- cloud page ----------

// Designed cover for cloud/AI entries whose official site publishes no
// usable cover image (or whose image failed to load): the service's
// brand-colour gradient + its name's initial. Never a stock photo or a
// fake screenshot. Known image-less curated services get their real
// brand hues; anything else derives a stable hue pair from its id.
const CLOUD_COVER_BRANDS: Record<string, { from: string; to: string }> = {
  "curated-ai-siliconflow": { from: "#3b4cc0", to: "#0e9de8" },
  "curated-ai-volcengine": { from: "#1664ff", to: "#00b8ff" },
};
const CLOUD_COVER_FALLBACKS: { from: string; to: string }[] = [
  { from: "#0f766e", to: "#2dd4bf" },
  { from: "#9a3412", to: "#f59e0b" },
  { from: "#334155", to: "#7d8aa5" },
  { from: "#065f46", to: "#34d399" },
  { from: "#7c2d12", to: "#fb923c" },
  { from: "#155e75", to: "#38bdf8" },
];

function cloudCoverDesign(deal: Deal): { from: string; to: string; initial: string; name: string } {
  const brand = CLOUD_COVER_BRANDS[deal.externalId];
  let pair = brand;
  if (!pair) {
    let h = 0;
    for (let i = 0; i < deal.externalId.length; i++) h = (h * 31 + deal.externalId.charCodeAt(i)) >>> 0;
    pair = CLOUD_COVER_FALLBACKS[h % CLOUD_COVER_FALLBACKS.length] ?? CLOUD_COVER_FALLBACKS[0];
  }
  const full = dealTitle(deal);
  const name = (full.split("·")[0] ?? full).trim() || full;
  const initial = (name.replace(/^[《「"'\s]+/, "").charAt(0) || "羊").toUpperCase();
  return { from: pair?.from ?? "#334155", to: pair?.to ?? "#64748b", initial, name };
}

/** 云服务 / AI 卡：横向长条（用户要求「不要大方块」）。
 * 左侧一枚方形品牌板（logo 优先，contain 不裁切），右侧标题 / 平台 /
 * 价格 / 时间一屏读完。整卡点击进详情，键盘可操作。 */
function CloudCard({ deal, now, onOpen }: { deal: Deal; now: number; onOpen: (deal: Deal) => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const cd = countdown(deal.endAt, now);
  const worth = money(deal.worthCents);
  const title = dealTitle(deal);
  const platLine = [categoryLabel(deal), platformZh(deal.platform)].filter(Boolean).join(" · ").toUpperCase();
  const design = cloudCoverDesign(deal);
  const showLogo = !!deal.logoUrl && !logoFailed;
  const showImg = !showLogo && !!deal.imageUrl && !imgFailed;
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`查看详情：${title}`}
      onClick={() => onOpen(deal)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(deal);
        }
      }}
      className={`flex cursor-pointer items-stretch gap-3 overflow-hidden rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-[var(--glass-hi)] backdrop-blur-md transition-colors ${deal.hidden ? "opacity-60" : ""}`}
    >
      {/* square brand plate — never a wide 16:9 block */}
      <div className="relative h-[76px] w-[76px] flex-none overflow-hidden rounded-[12px] bg-[var(--surface2)]">
        {showLogo ? (
          <div className="absolute inset-0" style={{ background: "var(--logo-plate)" }}>
            <img
              src={deal.logoUrl ?? ""}
              alt=""
              loading="lazy"
              onError={() => setLogoFailed(true)}
              className="absolute inset-0 m-auto max-h-[62%] max-w-[68%] object-contain"
            />
          </div>
        ) : showImg ? (
          <img
            src={deal.imageUrl ?? ""}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 flex flex-col items-center justify-center gap-0.5"
            style={{ background: `linear-gradient(120deg, ${design.from}, ${design.to})` }}
          >
            <span className="font-serif text-[30px] font-black leading-none text-white/95">{design.initial}</span>
            <span className="max-w-[86%] truncate text-[8px] font-bold tracking-[0.06em] text-white/85">{design.name}</span>
          </div>
        )}
        {deal.regionLocked ? (
          <span className="absolute left-1 top-1 rounded-full px-1.5 py-[2px] text-[8px] font-bold leading-none" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>锁区</span>
        ) : null}
      </div>

      {/* details column */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[5px]">
        <h4 className="truncate text-[13px] font-bold leading-[1.25] text-[var(--text)]">{title}</h4>
        <p className="truncate font-mono text-[9px] tracking-[0.03em] text-[var(--dim2)]">{platLine}</p>
        <div className="flex items-baseline gap-[7px]">
          {deal.status === "upcoming" ? (
            <b className="text-xs font-bold text-[var(--text)]">{worth ? `原价 ${worth}` : "即将免费"}</b>
          ) : (
            <>
              <b className="text-xs font-bold text-[var(--free-ink)]">免费</b>
              {worth ? <s className="font-mono text-[10px] text-[var(--dim2)]">{worth}</s> : null}
            </>
          )}
          <span className={`ml-auto flex-none font-mono text-[9.5px] font-medium ${deal.claimed ? "text-[var(--free-ink)]" : "text-[var(--accent)]"}`}>
            {deal.claimed ? "已领取" : deal.status === "upcoming" ? (deal.publishedAt ? `${fmtDate(deal.publishedAt)} 开始` : "即将开始") : cd ? cd.text : "长期"}
          </span>
        </div>
      </div>
    </article>
  );
}

function CloudPage({ deals, now, onOpen, hideClaimed, hideHidden }: { deals: Deal[]; now: number; onOpen: (d: Deal) => void; hideClaimed: boolean; hideHidden: boolean }) {
  const [chip, setChip] = useState<"all" | "cloud" | "ai">("all");
  const list = useMemo(
    () =>
      deals.filter(
        (d) =>
          (chip === "all" ? d.tags.includes("cloud") || d.tags.includes("ai") : d.tags.includes(chip)) &&
          (!hideClaimed || !d.claimed) &&
          (!hideHidden || !d.hidden),
      ),
    [deals, chip, hideClaimed, hideHidden],
  );
  return (
    <div>
      <div className="flex items-baseline gap-2 pb-1 pt-4">
        <h1 className="font-serif text-[26px] font-black leading-none text-[var(--text)]">云服务</h1>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--dim2)]">CLOUD &amp; AI</span>
      </div>
      <ChipsRow label="云服务筛选">
        <Chip active={chip === "all"} onClick={() => setChip("all")} label="全部" ariaLabel="全部云服务与 AI" />
        <Chip active={chip === "cloud"} onClick={() => setChip("cloud")} label="云服务" ariaLabel="只看云服务" />
        <Chip active={chip === "ai"} onClick={() => setChip("ai")} label="AI" ariaLabel="只看 AI 额度" />
      </ChipsRow>
      <div className="mt-4">
        {list.length > 0 ? (
          <div className="flex flex-col gap-3">
            {list.map((d) => (
              <CloudCard key={d.id} deal={d} now={now} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <EmptyNote title="暂无内容" />
        )}
      </div>
    </div>
  );
}

// ---------- Steam official OpenID login ("Sign in through Steam") ----------
// Steam's official third-party login is OpenID 2.0: the panel opens
// steamcommunity.com's login page with openid.return_to set to THIS
// page's own address plus a one-time bind ticket (steamOpenIdStart).
// The user types their Steam password only on Steam's site; Steam then
// redirects back to this page with a signed assertion in the query
// string. The returned page instance reads the assertion from its own
// address bar and submits it to steamOpenIdVerify, which relays it to
// Steam's check_authentication endpoint — no copying, no pasting, and
// the password never touches this app. The ticket (not the browser
// session) ties the return to the right in-app account, so the flow
// still completes when the popup lives in a different browser context.
function buildSteamOpenIdUrl(ticket: string): string {
  const here = `${window.location.origin}${window.location.pathname}`;
  const returnTo = `${here}?steam_ticket=${encodeURIComponent(ticket)}`;
  const q = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": window.location.origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `https://steamcommunity.com/openid/login?${q.toString()}`;
}

type SteamReturn = { params: Record<string, string>; ticket: string | null };

function steamReturnFromSearch(search: string): SteamReturn | null {
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (!sp.get("openid.claimed_id") && sp.get("openid.mode") !== "id_res") return null;
  const params: Record<string, string> = {};
  sp.forEach((v, k) => {
    if (k.startsWith("openid.")) params[k] = v;
  });
  if (Object.keys(params).length === 0) return null;
  return { params, ticket: sp.get("steam_ticket") };
}

/** Parse a pasted Steam return address (or a bare query string) into the
 *  assertion params + ticket for steamOpenIdVerify. */
function steamReturnFromText(text: string): SteamReturn | null {
  const s = text.trim();
  if (!s) return null;
  try {
    return steamReturnFromSearch(new URL(s).search);
  } catch {
    const q = s.includes("?") ? s.slice(s.indexOf("?")) : s;
    return steamReturnFromSearch(q.startsWith("?") ? q : `?${q}`);
  }
}

/** The page Steam redirected back to: submits the signed assertion from
 *  its own address bar to the server for Steam-side verification, then
 *  shows the outcome. Rendered instead of the whole app for that load. */
function SteamReturnView({ ret, authToken }: { ret: SteamReturn; authToken?: string }) {
  const ranRef = useRef(false);
  const [result, setResult] = useState<{ ok: boolean; displayName: string | null; note: string } | null>(null);
  useEffect(() => {
    // Strip the assertion params from the address bar immediately: they
    // are single-purpose and a refresh must not resubmit them.
    try {
      window.history.replaceState(null, "", `${window.location.origin}${window.location.pathname}`);
    } catch {
      // noop — the params staying visible is cosmetic only
    }
  }, []);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    api
      .steamOpenIdVerify({ params: ret.params, ticket: ret.ticket ?? undefined, authToken })
      .then((r) => setResult(r))
      .catch((e) => setResult({ ok: false, displayName: null, note: `绑定失败：${e instanceof Error ? e.message : String(e)}` }));
  }, [ret, authToken]);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 py-16 text-center">
      <h1 className="font-serif text-2xl font-bold text-[var(--text)]">Steam 绑定</h1>
      {result === null ? (
        <p className="mt-4 text-sm leading-[1.8] text-[var(--dim)]">正在向 Steam 核验这次登录…</p>
      ) : result.ok ? (
        <>
          <p className="mt-4 text-base font-bold text-[var(--free-ink)]">绑定成功{result.displayName ? `：${result.displayName}` : ""}</p>
          <p className="mt-2 text-sm leading-[1.8] text-[var(--dim)]">{result.note}</p>
        </>
      ) : (
        <>
          <p className="mt-4 text-base font-bold text-[var(--warn)]">绑定没有完成</p>
          <p className="mt-2 text-sm leading-[1.8] text-[var(--dim)]">{result.note}</p>
        </>
      )}
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          aria-label="关闭此页"
          onClick={() => window.close()}
          className="rounded-[14px] bg-grad px-5 py-2.5 text-sm font-bold text-[var(--accent-ink)]"
        >
          关闭此页
        </button>
        <button
          type="button"
          aria-label="回到空间"
          onClick={() => window.location.replace(`${window.location.origin}${window.location.pathname}`)}
          className="rounded-[14px] border border-[var(--border)] px-5 py-2.5 text-sm font-bold text-[var(--text)]"
        >
          回到空间
        </button>
      </div>
      <p className="mt-4 text-xs leading-[1.7] text-[var(--dim2)]">如果是在弹窗里登录的，关掉此页回到空间即可，绑定状态会自动刷新。</p>
    </main>
  );
}

// ---------- mine page ----------

function PlatformLoginPanel({
  platform,
  status,
  loginUrl,
  onDone,
  onBound,
  authToken,
}: {
  platform: PlatformKey;
  status: PlatformStatus;
  loginUrl: string | null;
  onDone: () => void;
  onBound?: () => void;
  authToken?: string;
}) {
  const [code, setCode] = useState("");
  const [steamId, setSteamId] = useState(status.accountRef ?? "");
  const [apiKey, setApiKey] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // Failure notes (incl. the platform's raw error text) render in the warn
  // colour so they are not mistaken for the panel's grey helper text.
  const [noteBad, setNoteBad] = useState(false);
  // Popup login flow (Epic / GOG): the platform's official login page opens
  // in a popup window. The authorization code itself stays on the platform's
  // origin (browser same-origin policy — a web page cannot read a
  // cross-origin popup's URL or page content, unlike a native app's embedded
  // webview), so completion here is ONE click on 「完成绑定」, which reads
  // the clipboard content the user copied on the platform's post-login page
  // and submits it. The paste field survives only as a fallback.
  const popupRef = useRef<Window | null>(null);
  // Single-flight submit lock, set SYNCHRONOUSLY on the first tap: an Epic
  // authorization code can be exchanged exactly once, and this panel has two
  // submit paths for the same code (clipboard completion + paste submit).
  // The clipboard path awaits readText() before the mutation's isPending
  // turns true, so without this lock a second tap inside that window fires
  // a second exchange of the same code — which Epic answers with
  // authorization_code_not_found, and whose failure then masks the first
  // attempt's outcome. The server independently refuses a resubmitted code
  // fingerprint; this lock keeps the duplicate from being sent at all.
  const submitLockRef = useRef(false);
  const [phase, setPhase] = useState<"start" | "waiting">("start");
  const [popupClosed, setPopupClosed] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  // The paste field starts OPEN: the Epic code's ~5-minute clock starts when
  // the code page appears, so making the user first hunt for a “手动粘贴”
  // toggle wastes the very seconds the bind has. It stays toggleable.
  const [showPaste, setShowPaste] = useState(true);
  const [clipNote, setClipNote] = useState<string | null>(null);
  // 原生 iOS 壳：网页登录成功后由 AppDelegate 的 WKWebView 自动回传授权码，
  // 无需再让用户复制粘贴。Web 端恒为 false，保持原流程。
  const nativeMode = platform !== "steam" && isNativePlatform();
  const [autoLink, setAutoLink] = useState<"idle" | "waiting" | "linking" | "done">("idle");

  useEffect(() => {
    if (phase !== "waiting") return;
    const t = window.setInterval(() => {
      const w = popupRef.current;
      if (!w) return;
      let closed = false;
      try {
        closed = w.closed;
      } catch {
        closed = false;
      }
      if (closed) setPopupClosed(true);
    }, 1500);
    return () => window.clearInterval(t);
  }, [phase]);

  const handleLoginResult = (r: { ok: boolean; note: string }) => {
    setNote(r.note);
    setNoteBad(!r.ok);
    setAutoLink((prev) => (prev === "idle" ? prev : r.ok ? "done" : "idle"));
    onDone();
    if (r.ok) {
      try {
        popupRef.current?.close();
      } catch {
        // cross-origin popup handle may already be gone — the binding is done anyway
      }
      popupRef.current = null;
      onBound?.();
    }
  };

  const epicLogin = useMutation({
    mutationFn: (c: string) => api.epicLogin({ code: c, authToken }),
    onSuccess: handleLoginResult,
    onError: (e) => {
      setNote(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
      setNoteBad(true);
      setAutoLink("idle");
    },
    onSettled: () => {
      submitLockRef.current = false;
    },
  });
  const gogLogin = useMutation({
    mutationFn: (c: string) => api.gogLogin({ code: c, authToken }),
    onSuccess: handleLoginResult,
    onError: (e) => {
      setNote(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
      setNoteBad(true);
      setAutoLink("idle");
    },
    onSettled: () => {
      submitLockRef.current = false;
    },
  });
  // 原生自动回连：网页登录成功后，AppDelegate 的 WKWebView 抓到授权码并
  // 以 CustomEvent 回传。这里直接复用与手动粘贴完全相同的 epicLogin /
  // gogLogin 动作，因此兑换、验重、诊断日志、进度刷新全部一致。
  const nativeSubmitRef = useRef<(code: string) => void>(() => {});
  nativeSubmitRef.current = (code: string) => {
    if (submitLockRef.current) return;
    if (platform !== "epic" && platform !== "gog") return;
    submitLockRef.current = true;
    setAutoLink("linking");
    setNote(null);
    setNoteBad(false);
    if (platform === "epic") epicLogin.mutate(code);
    else gogLogin.mutate(code);
  };
  useEffect(() => {
    if (!nativeMode) return;
    return onPlatformAuthCode((payload) => {
      if (payload.platform !== platform) return;
      // nativeSubmitRef 内部会把 autoLink 置为 "linking"。
      nativeSubmitRef.current(payload.code);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeMode, platform]);

  const steamBind = useMutation({
    mutationFn: () => api.steamBind({ steamId: steamId.trim(), apiKey: apiKey.trim() ? apiKey.trim() : undefined, authToken }),
    onSuccess: (r) => {
      setNote(r.note);
      setNoteBad(!r.ok);
      onDone();
    },
    onError: (e) => {
      setNote(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
      setNoteBad(true);
    },
  });
  // Steam official OpenID flow: a one-time ticket is fetched up front so
  // the login URL is ready synchronously inside the tap handler (popup
  // blockers reject window.open calls made after an await).
  const [steamLoginUrl, setSteamLoginUrl] = useState<string | null>(null);
  const [steamUrlText, setSteamUrlText] = useState("");
  const [showLegacyForm, setShowLegacyForm] = useState(false);
  const steamStart = useMutation({
    mutationFn: () => api.steamOpenIdStart({ authToken }),
    onSuccess: (r) => {
      try {
        setSteamLoginUrl(buildSteamOpenIdUrl(r.ticket));
      } catch {
        setSteamLoginUrl(null);
      }
    },
    onError: (e) => {
      setNote(`准备 Steam 登录链接失败：${e instanceof Error ? e.message : String(e)}`);
      setNoteBad(true);
    },
  });
  const steamVerify = useMutation({
    mutationFn: (ret: SteamReturn) => api.steamOpenIdVerify({ params: ret.params, ticket: ret.ticket ?? undefined, authToken }),
    onSuccess: handleLoginResult,
    onError: (e) => {
      setNote(`绑定失败：${e instanceof Error ? e.message : String(e)}`);
      setNoteBad(true);
    },
  });
  // Key save for an ALREADY bound Steam account (the key is optional and
  // only gates library sync — it never gates the binding itself).
  const steamSaveKey = useMutation({
    mutationFn: () =>
      api.steamBind({ steamId: (status.accountRef ?? steamId).trim(), apiKey: apiKey.trim() ? apiKey.trim() : undefined, authToken }),
    onSuccess: (r) => {
      setNote(r.note);
      setNoteBad(!r.ok);
      onDone();
    },
    onError: (e) => {
      setNote(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      setNoteBad(true);
    },
  });
  const steamTicketAskedRef = useRef(false);
  useEffect(() => {
    if (platform !== "steam" || steamTicketAskedRef.current) return;
    steamTicketAskedRef.current = true;
    steamStart.mutate();
    // only on mount — the ticket is refreshed by re-opening the panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);
  // While waiting for the Steam return, poll the binding status: the
  // binding completes on the RETURNED page (possibly another browser
  // context), so this window learns about it from getAccounts, not from
  // a local mutation.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (platform !== "steam" || phase !== "waiting") return;
    const t = window.setInterval(() => onDoneRef.current(), 4000);
    return () => window.clearInterval(t);
  }, [platform, phase]);
  useEffect(() => {
    if (platform !== "steam" || phase !== "waiting" || !status.bound) return;
    setPhase("start");
    onBound?.();
  }, [platform, phase, status.bound, onBound]);

  const inputCls = "w-full rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm text-[var(--text)] outline-none backdrop-blur-md focus:border-[var(--accent)]";
  const pending = epicLogin.isPending || gogLogin.isPending || steamBind.isPending || steamVerify.isPending || steamSaveKey.isPending;

  const startLogin = () => {
    setClipNote(null);
    setPopupBlocked(false);
    setPopupClosed(false);
    setNote(null);
    setNoteBad(false);

    // 原生 iOS：交给 AppDelegate 的内嵌 WKWebView。登录成功后原生层自动
    // 回传授权码（fgameOAuthCode 事件），由上面的 effect 自动完成绑定，
    // 用户全程不需要复制 / 粘贴任何东西。
    if (nativeMode && loginUrl && (platform === "epic" || platform === "gog")) {
      if (openPlatformLoginNative(platform, loginUrl)) {
        setPhase("waiting");
        setAutoLink("waiting");
        setShowPaste(false);
        return;
      }
    }

    let w: Window | null = null;
    try {
      w = window.open(loginUrl ?? undefined, `platform-login-${platform}`, "width=520,height=800");
    } catch {
      w = null;
    }
    if (w) {
      popupRef.current = w;
      try {
        w.focus();
      } catch {
        // noop — popup is open either way
      }
      setPhase("waiting");
    } else {
      // Popup blocked by the browser/webview: fall back to a plain link plus
      // the manual paste field instead of leaving the user stuck.
      setPopupBlocked(true);
      setShowPaste(true);
    }
  };

  const finishFromClipboard = async () => {
    // Locked synchronously, before the clipboard await — see submitLockRef.
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setClipNote(null);
    let text = "";
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        text = await navigator.clipboard.readText();
      }
    } catch {
      text = "";
    }
    const c = (text ?? "").trim();
    const looksRight =
      platform === "epic"
        ? c.includes("authorizationCode") || /^[A-Za-z0-9_-]{16,}$/.test(c)
        : /[?&]code=/.test(c) || /^[A-Za-z0-9._~-]{16,}$/.test(c);
    if (c.length >= 4 && looksRight) {
      // The mutation's onSettled releases the submit lock.
      if (platform === "epic") epicLogin.mutate(c);
      else gogLogin.mutate(c);
    } else {
      submitLockRef.current = false;
      setClipNote(
        c.length >= 4
          ? platform === "gog"
            ? "剪贴板里的内容不像 GOG 成功页链接：请在登录后的白屏成功页复制地址栏整条链接，再点一次「完成绑定」。"
            : "剪贴板里的内容不像登录代码：请在登录成功的页面重新复制，再点一次「完成绑定」。"
          : platform === "gog"
            ? "没读到剪贴板：请先在登录后的白屏成功页复制地址栏整条链接，再点一次「完成绑定」；或用手动粘贴。"
            : "没读到剪贴板：请先在登录成功的页面复制好内容，再点一次「完成绑定」；或用手动粘贴。",
      );
      setShowPaste(true);
    }
  };

  const submitPaste = () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    if (platform === "epic") epicLogin.mutate(code.trim());
    else gogLogin.mutate(code.trim());
  };

  const startSteamLogin = () => {
    setClipNote(null);
    setPopupBlocked(false);
    setPopupClosed(false);
    if (!steamLoginUrl) {
      // Ticket prefetch has not landed yet (or failed): fetch now — the
      // popup may then be blocked, in which case the fallback link below
      // (same URL) is offered instead.
      if (!steamStart.isPending) steamStart.mutate();
      setClipNote("登录链接正在准备，稍候再点一次按钮。");
      return;
    }
    let w: Window | null = null;
    try {
      w = window.open(steamLoginUrl, "platform-login-steam", "width=520,height=800");
    } catch {
      w = null;
    }
    if (w) {
      popupRef.current = w;
      try {
        w.focus();
      } catch {
        // noop — popup is open either way
      }
      setPhase("waiting");
    } else {
      setPopupBlocked(true);
    }
  };

  const submitSteamPaste = () => {
    const ret = steamReturnFromText(steamUrlText);
    if (!ret) {
      setClipNote("这段内容里没有读到 Steam 的跳回参数：请粘贴 Steam 登录成功后跳回页面地址栏里的整条地址。");
      return;
    }
    setClipNote(null);
    steamVerify.mutate(ret);
  };

  if (platform === "steam") {
    const steamDiag =
      status.bindAttempts.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-xs font-bold text-[var(--dim)]">服务端记录 · 最近 {status.bindAttempts.length} 次提交</p>
          {status.bindAttempts.map((a, i) => (
            <p key={`${i}-${a}`} className="text-xs leading-[1.7] text-[var(--warn)]">
              {a}
            </p>
          ))}
        </div>
      ) : status.lastBindError ? (
        <p className="text-xs font-medium leading-[1.7] text-[var(--warn)]">服务端记录 · {status.lastBindError}</p>
      ) : null;
    const steamNote = note ? (
      <p className={`text-xs font-medium leading-[1.7] ${noteBad ? "text-[var(--warn)]" : "text-[var(--dim)]"}`}>{note}</p>
    ) : null;

    if (status.bound) {
      // Bound: the binding stands on the OpenID login alone. The Web API
      // Key lives here as an OPTIONAL extra that only unlocks library
      // sync / playtime — never a condition of being bound.
      return (
        <div className="grid gap-3">
          <p className="text-xs leading-[1.7] text-[var(--dim)]">
            已绑定{status.displayName ? `：${status.displayName}` : ""}。绑定不需要 API Key；下面的 Key 只是同步游戏库时才用。
          </p>
          <div>
            <label htmlFor="steam-key" className="text-xs font-medium text-[var(--dim)]">
              Steam Web API Key（可选，仅用于同步游戏库）{status.hasApiKey ? `（已保存 ${status.apiKeyMasked ?? ""}，留空不改）` : ""}
            </label>
            <input id="steam-key" aria-label="Steam Web API Key" type="password" autoComplete="off" className={`${inputCls} mt-1`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="在 steamcommunity.com/dev/apikey 免费申请，只存服务端" />
          </div>
          <p className="text-xs leading-[1.7] text-[var(--dim2)]">
            同步走 Steam 官方 Web API，需要你的 Key，且资料里「游戏详情」要设为公开。不填 Key 也算绑定成功，只是暂时不能同步游戏库和时长。
          </p>
          {steamNote}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="保存 Steam API Key 并同步游戏库"
              disabled={pending || !apiKey.trim()}
              onClick={() => steamSaveKey.mutate()}
              className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
            >
              {steamSaveKey.isPending ? "同步中…" : "保存 Key 并同步"}
            </button>
            <button
              type="button"
              aria-label="重新打开 Steam 官方登录页"
              onClick={startSteamLogin}
              className="rounded-[14px] border border-[var(--border)] px-3 py-2.5 text-xs font-medium text-[var(--dim)]"
            >
              重新用 Steam 登录
            </button>
          </div>
          {popupBlocked && steamLoginUrl ? (
            <a
              href={steamLoginUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="在新页面打开 Steam 官方登录页"
              className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-2.5 text-center text-sm font-bold text-[var(--text)]"
            >
              弹窗被拦截：在新页面打开 Steam 登录页 →
            </a>
          ) : null}
          {steamDiag}
        </div>
      );
    }

    return (
      <div className="grid gap-3">
        {phase === "start" ? (
          <>
            <p className="text-xs leading-[1.7] text-[var(--dim)]">
              点按钮弹出 Steam 官方登录页，在 Steam 官网输账号密码（密码只输在官网）。登录后 Steam 会自动跳回本页完成绑定，不用复制粘贴任何东西。
            </p>
            <button
              type="button"
              aria-label="打开 Steam 官方登录页"
              disabled={steamStart.isPending && !steamLoginUrl}
              onClick={startSteamLogin}
              className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
            >
              {steamLoginUrl ? "打开 Steam 官方登录页" : "正在准备登录链接…"}
            </button>
          </>
        ) : (
          <>
            <p className="text-xs leading-[1.7] text-[var(--dim)]">
              {popupClosed ? "Steam 登录窗口已关闭。" : "Steam 登录窗口开着，在窗口里完成登录。"}
              登录成功后 Steam 会自动跳回本页完成绑定，绑定状态会自动刷新；如果跳回的页面停在「绑定成功」上，关掉它回到这里即可。
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="重新打开 Steam 登录窗口"
                onClick={startSteamLogin}
                className="border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--dim)]"
              >
                重新打开登录窗口
              </button>
              <button
                type="button"
                aria-label="手动粘贴 Steam 跳回地址"
                aria-expanded={showPaste}
                onClick={() => setShowPaste((v) => !v)}
                className="border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--dim)]"
              >
                手动粘贴跳回地址
              </button>
            </div>
          </>
        )}
        {popupBlocked ? (
          <div className="grid gap-2">
            <p className="text-xs font-medium leading-[1.7] text-[var(--dim)]">
              弹窗被浏览器拦截了：用下面的链接在新页面登录，登录后 Steam 会跳回本页自动完成绑定。
            </p>
            {steamLoginUrl ? (
              <a
                href={steamLoginUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="在新页面打开 Steam 官方登录页"
                className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-2.5 text-center text-sm font-bold text-[var(--text)]"
              >
                打开 Steam 官方登录页 →
              </a>
            ) : null}
          </div>
        ) : null}
        {clipNote ? <p className="text-xs font-medium leading-[1.7] text-[var(--dim)]">{clipNote}</p> : null}
        {showPaste ? (
          <div className="grid gap-2 border-t border-[var(--border)] pt-3">
            <div>
              <label htmlFor="steam-return-url" className="text-xs font-medium text-[var(--dim)]">
                跳回地址（备用粘贴）
              </label>
              <textarea
                id="steam-return-url"
                aria-label="Steam 跳回地址"
                rows={3}
                className={`${inputCls} mt-1 resize-none font-mono text-xs`}
                value={steamUrlText}
                onChange={(e) => setSteamUrlText(e.target.value)}
                placeholder="粘贴 Steam 登录后跳回页面地址栏里的整条地址"
              />
            </div>
            <button
              type="button"
              aria-label="提交 Steam 跳回地址并完成绑定"
              disabled={pending || !steamUrlText.trim()}
              onClick={submitSteamPaste}
              className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-2.5 text-sm font-bold text-[var(--text)] disabled:opacity-50"
            >
              {steamVerify.isPending ? "核验中…" : "提交并完成绑定"}
            </button>
          </div>
        ) : null}
        {steamNote}
        {steamDiag}
        <div className="border-t border-[var(--border)] pt-3">
          <button
            type="button"
            aria-label="旧方式手动绑定 Steam"
            aria-expanded={showLegacyForm}
            onClick={() => setShowLegacyForm((v) => !v)}
            className="text-xs font-medium text-[var(--dim2)] underline underline-offset-4"
          >
            旧方式：手动填 SteamID + Key 绑定
          </button>
          {showLegacyForm ? (
            <div className="mt-3 grid gap-3">
              <div>
                <label htmlFor="steam-id" className="text-xs font-medium text-[var(--dim)]">SteamID64（17 位数字，或个人资料链接）</label>
                <input id="steam-id" aria-label="SteamID64" className={`${inputCls} mt-1`} value={steamId} onChange={(e) => setSteamId(e.target.value)} placeholder="7656119xxxxxxxxxx" />
              </div>
              <div>
                <label htmlFor="steam-key-legacy" className="text-xs font-medium text-[var(--dim)]">
                  我的 Steam Web API Key{status.hasApiKey ? `（已保存 ${status.apiKeyMasked ?? ""}，留空不改）` : ""}
                </label>
                <input id="steam-key-legacy" aria-label="Steam Web API Key" type="password" autoComplete="off" className={`${inputCls} mt-1`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="在 steamcommunity.com/dev/apikey 申请，只存服务端" />
              </div>
              <p className="text-xs leading-[1.7] text-[var(--dim2)]">同步走 Steam 官方 Web API，需要资料里「游戏详情」设为公开；没有 Key 时只能先绑定 SteamID。</p>
              <button
                type="button"
                aria-label="保存 Steam 绑定并同步游戏库"
                disabled={pending || !steamId.trim()}
                onClick={() => steamBind.mutate()}
                className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-2.5 text-sm font-bold text-[var(--text)] disabled:opacity-50"
              >
                {steamBind.isPending ? "同步中…" : "保存并同步游戏库"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const isEpic = platform === "epic";
  const name = PLATFORM_NAMES[platform];

  // ── 原生 iOS：网页登录 → 应用自动回连（小黑盒式，无需复制粘贴）──
  // Web 端不会进入此分支，沿用下面完整的 popup + 剪贴板流程。
  if (nativeMode) {
    return (
      <div className="grid gap-3">
        {autoLink === "done" ? (
          <div className="grid gap-2">
            <p className="bind-status text-sm font-bold leading-[1.7] text-[var(--free-ink)]">✓ 已自动绑定 {name} 账号</p>
          </div>
        ) : (
          <>
            <p className="text-xs leading-[1.7] text-[var(--dim)]">
              点按钮打开 {name} 官方登录页，在页面里登录（密码只输在官网）。<b className="text-[var(--text)]">登录成功后应用会自动完成绑定</b>，不用复制粘贴任何代码或链接。
            </p>
            {autoLink === "waiting" ? (
              <p className="text-xs font-medium leading-[1.7] text-[var(--accent)]">● 登录页已打开，正在等待你在网页里完成登录…</p>
            ) : null}
            {autoLink === "linking" ? (
              <p className="text-xs font-medium leading-[1.7] text-[var(--accent)]">● 已收到登录结果，正在自动绑定 {name}…</p>
            ) : null}
            <button
              type="button"
              aria-label={`打开 ${name} 官方登录页`}
              disabled={!loginUrl || autoLink === "linking"}
              onClick={startLogin}
              className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
            >
              {autoLink === "waiting" ? "重新打开登录页" : `打开 ${name} 官方登录页`}
            </button>
          </>
        )}
        {note ? (
          <p className={`text-xs font-medium leading-[1.7] ${noteBad ? "text-[var(--warn)]" : "text-[var(--dim)]"}`}>{note}</p>
        ) : null}
        {status.bindAttempts.length > 0 ? (
          <div className="grid gap-1">
            <p className="text-xs font-bold text-[var(--dim)]">服务端记录 · 最近 {status.bindAttempts.length} 次提交</p>
            {status.bindAttempts.map((a, i) => (
              <p key={`${i}-${a}`} className="text-xs leading-[1.7] text-[var(--warn)]">{a}</p>
            ))}
          </div>
        ) : status.lastBindError ? (
          <p className="text-xs font-medium leading-[1.7] text-[var(--warn)]">服务端记录 · {status.lastBindError}</p>
        ) : null}
        {/* 兜底：原生自动回连万一失败，仍可手动粘贴（复用同一兑换动作） */}
        <div className="border-t border-[var(--border)] pt-3">
          <button
            type="button"
            aria-label="手动粘贴授权码"
            aria-expanded={showPaste}
            onClick={() => setShowPaste((v) => !v)}
            className="text-xs font-medium text-[var(--dim2)] underline underline-offset-4"
          >
            自动绑定没成功？手动粘贴授权码
          </button>
          {showPaste ? (
            <div className="mt-3 grid gap-2">
              <div>
                <label htmlFor="native-auth-code" className="text-xs font-medium text-[var(--dim)]">
                  授权码 / 登录成功页链接
                </label>
                <textarea
                  id="native-auth-code"
                  aria-label="授权码"
                  rows={3}
                  className={`${inputCls} mt-1 resize-none font-mono text-xs`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="粘贴 Epic 显示的代码，或 GOG 成功页地址栏整条链接"
                />
              </div>
              <button
                type="button"
                aria-label="提交授权码并完成绑定"
                disabled={pending || !code.trim()}
                onClick={submitPaste}
                className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] px-4 py-2.5 text-sm font-bold text-[var(--text)] backdrop-blur-md disabled:opacity-50"
              >
                {pending ? "绑定同步中…" : "提交并完成绑定"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {phase === "start" ? (
        <>
          <p className="text-xs leading-[1.7] text-[var(--dim)]">
            点按钮弹出 {name} 官方登录页，在页面里登录，密码只输在官网。登录成功后回到这里，点一次「完成绑定」即可。
          </p>
          {!isEpic ? (
            <p className="text-xs font-medium leading-[1.7] text-[var(--warn)]">
              先说清：GOG 登录成功后页面会变白，那是成功页，别等——复制地址栏整条链接，回来点「完成绑定」。
            </p>
          ) : null}
          <button
            type="button"
            aria-label={`打开 ${name} 官方登录弹窗`}
            disabled={!loginUrl}
            onClick={startLogin}
            className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
          >
            打开 {name} 官方登录页
          </button>
        </>
      ) : (
        <>
          <p className="text-xs leading-[1.7] text-[var(--dim)]">
            {popupClosed ? `${name} 登录窗口已关闭。` : `${name} 登录窗口开着，在窗口里完成登录。`}
            {isEpic
              ? "登录成功后页面会显示一段代码内容，全选复制整段，再点下面按钮。同一个码只能提交一次：复制后立刻回来点「完成绑定」，不要重复点、也不要两次用不同的按钮提交同一个码——重复提交只会让 Epic 回“码不存在”。"
              : "登录成功后页面会变白——那就是成功页，没卡住。复制地址栏里的整条链接（里面带授权码），回来点下面按钮。"}
          </p>
          <button
            type="button"
            aria-label={`完成 ${name} 绑定`}
            disabled={pending}
            onClick={() => void finishFromClipboard()}
            className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
          >
            {pending ? "绑定同步中…" : "完成绑定"}
          </button>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-label={`重新打开 ${name} 登录窗口`}
              onClick={startLogin}
              className="border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--dim)]"
            >
              重新打开登录窗口
            </button>
            <button
              type="button"
              aria-label="手动粘贴授权码"
              aria-expanded={showPaste}
              onClick={() => setShowPaste((v) => !v)}
              className="border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--dim)]"
            >
              手动粘贴授权码
            </button>
          </div>
        </>
      )}
      {popupBlocked ? (
        <div className="grid gap-2">
          <p className="text-xs font-medium leading-[1.7] text-[var(--dim)]">
            弹窗被浏览器拦截了：用下面的链接在新页面登录，登录后照样复制内容，回来点「完成绑定」。
          </p>
          {loginUrl ? (
            <a
              href={loginUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`在新页面打开 ${name} 官方登录页`}
              className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-2.5 text-center text-sm font-bold text-[var(--text)]"
            >
              打开 {name} 官方登录页 →
            </a>
          ) : null}
          {phase === "start" ? (
            <button
              type="button"
              aria-label={`完成 ${name} 绑定`}
              disabled={pending}
              onClick={() => void finishFromClipboard()}
              className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
            >
              {pending ? "绑定同步中…" : "完成绑定"}
            </button>
          ) : null}
        </div>
      ) : null}
      {clipNote ? <p className="text-xs font-medium leading-[1.7] text-[var(--dim)]">{clipNote}</p> : null}
      {status.bindAttempts.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-xs font-bold text-[var(--dim)]">服务端记录 · 最近 {status.bindAttempts.length} 次提交</p>
          {status.bindAttempts.map((a, i) => (
            <p key={`${i}-${a}`} className="text-xs leading-[1.7] text-[var(--warn)]">
              {a}
            </p>
          ))}
        </div>
      ) : status.lastBindError ? (
        <p className="text-xs font-medium leading-[1.7] text-[var(--warn)]">服务端记录 · {status.lastBindError}</p>
      ) : null}
      {showPaste ? (
        <div className="grid gap-2 border-t border-[var(--border)] pt-3">
          <div>
            <label htmlFor={`auth-code-${platform}`} className="text-xs font-medium text-[var(--dim)]">
              授权码（备用粘贴）
            </label>
            <textarea
              id={`auth-code-${platform}`}
              aria-label={`${name} 授权码`}
              rows={3}
              className={`${inputCls} mt-1 resize-none font-mono text-xs`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={isEpic ? "粘贴 authorizationCode 或整段 JSON" : "粘贴成功页（白屏页）地址栏里的整条链接，或单独的 code"}
            />
          </div>
          <button
            type="button"
            aria-label={`提交 ${name} 授权码并同步`}
            disabled={pending || !code.trim()}
            onClick={submitPaste}
            className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-2.5 text-sm font-bold text-[var(--text)] disabled:opacity-50"
          >
            {pending ? "绑定同步中…" : "提交并同步游戏库"}
          </button>
        </div>
      ) : null}
      {note ? <p className={`text-xs font-medium leading-[1.7] ${noteBad ? "text-[var(--warn)]" : "text-[var(--dim)]"}`}>{note}</p> : null}
    </div>
  );
}

type LibView = "list" | "grid" | "compact";
type LibSort = "default" | "playtime" | "name" | "recent";
type LibGroupKey = LibraryGroup["platform"];

/** Full playtime label for library entries: real hours, 未玩过 for a
 *  platform-verified 0, and an honest 暂无时长记录 when never synced. */
function playtimeLabel(minutes: number | null): string {
  if (minutes == null) return "暂无时长记录";
  if (minutes <= 0) return "未玩过";
  if (minutes < 60) return `${minutes} 分钟`;
  const h = minutes / 60;
  return `${h >= 100 ? Math.round(h) : h.toFixed(1)} 小时`;
}

function fmtDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function libOriginLabel(origin: LibraryEntry["origin"]): string {
  return origin === "sync" ? "平台同步入库" : origin === "claimed" ? "领取入库" : "手动添加（早期）";
}

function sortLibEntries(entries: LibraryEntry[], sort: LibSort): LibraryEntry[] {
  if (sort === "default") return entries;
  const arr = [...entries];
  if (sort === "playtime") {
    arr.sort((a, b) => (b.playtimeMinutes ?? -1) - (a.playtimeMinutes ?? -1) || a.title.localeCompare(b.title, "zh"));
  } else if (sort === "name") {
    arr.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  } else {
    // recent: newest addedAt first. addedAt is the platform's own
    // acquisition date where the platform reports one (Epic), else the
    // row's preserved first-sync time — either way it is a real per-game
    // date, not the last sync day. Ties (same-day acquisitions) fall back
    // to the row id — with title as the final tiebreak the order would
    // collapse back into name order and look like the sort did nothing.
    arr.sort(
      (a, b) =>
        new Date(b.addedAt ?? 0).getTime() - new Date(a.addedAt ?? 0).getTime() ||
        (b.itemId ?? 0) - (a.itemId ?? 0) ||
        a.title.localeCompare(b.title, "zh"),
    );
  }
  return arr;
}

function useRemoveLibraryEntry(entry: LibraryEntry, authToken: string | undefined, onRemoveClaimed: (dealId: number) => void, after?: () => void) {
  const queryClient = useQueryClient();
  const removeItem = useMutation({
    mutationFn: () => api.removeLibraryItem({ itemId: entry.itemId ?? 0, authToken }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      after?.();
    },
  });
  const remove = () => {
    if (entry.itemId != null) removeItem.mutate();
    else if (entry.dealId != null) {
      onRemoveClaimed(entry.dealId);
      after?.();
    }
  };
  return { remove, pending: removeItem.isPending };
}

/**
 * Epic 库专用设备标记：深色小胶囊里的线性 SVG —— 电脑（显示器）= PC
 * 版权益，手机 = 手游版权益，双平台就两个图标并排在同一胶囊里。数据
 * 来自服务端按 Epic 目录平台证据存下的 devicePlatforms，只对 Epic
 * 同步条目非空，Steam/GOG 与已领/手动条目不渲染。
 */
function DevicePlatformMarks({ platforms, className }: { platforms: ("pc" | "mobile")[]; className?: string }) {
  if (!platforms || platforms.length === 0) return null;
  const label = platforms.map((p) => (p === "pc" ? "电脑" : "手机")).join(" + ");
  return (
    <span
      role="img"
      aria-label={`可玩平台：${label}`}
      title={`可玩平台：${label}`}
      className={`img-chip pointer-events-none inline-flex flex-none items-center gap-[5px] rounded-full px-[7px] py-[4px] ${className ?? ""}`}
    >
      {platforms.includes("pc") ? (
        <svg viewBox="0 0 24 24" className="h-[11px] w-[11px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4.5" width="18" height="12" rx="1.8" />
          <path d="M9.5 20.5h5M12 16.5v4" />
        </svg>
      ) : null}
      {platforms.includes("mobile") ? (
        <svg viewBox="0 0 24 24" className="h-[11px] w-[11px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
          <path d="M10.8 18.6h2.4" />
        </svg>
      ) : null}
    </span>
  );
}

function LibraryEntryRow({ entry, onRemoveClaimed, onOpen, authToken }: { entry: LibraryEntry; onRemoveClaimed: (dealId: number) => void; onOpen: (entry: LibraryEntry) => void; authToken?: string }) {
  const { remove, pending } = useRemoveLibraryEntry(entry, authToken, onRemoveClaimed);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看游戏详情：${entry.title}`}
      onClick={() => onOpen(entry)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(entry);
        }
      }}
      className="flex cursor-pointer items-center gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-[9px] shadow-[var(--glass-hi)] backdrop-blur-md"
    >
      <SafeImg src={entry.imageUrl} alt="" label={entry.title} phFontSize={20} className="h-[54px] w-[54px] flex-none rounded-[10px] bg-[var(--surface2)] object-cover" loading="lazy" decoding="async" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h4 className="min-w-0 truncate text-[13px] font-bold leading-[1.3] text-[var(--text)]">{entry.title}</h4>
          <DevicePlatformMarks platforms={entry.devicePlatforms} />
        </div>
        <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.03em] text-[var(--dim2)]">
          {entry.origin === "sync" ? "同步" : entry.origin === "claimed" ? "已领" : "手动"}
          {` · ${playtimeLabel(entry.playtimeMinutes)}`}
        </p>
      </div>
      <button
        type="button"
        aria-label={`从库中移除 ${entry.title}`}
        disabled={pending}
        onClick={(e) => {
          e.stopPropagation();
          remove();
        }}
        className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-[var(--border)] text-[13px] text-[var(--dim)] disabled:opacity-50"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Grid tile: the WHOLE card is one fixed 3:4 cover box and the image is
 * absolutely stretched over it (object-cover), so every card is full-bleed
 * whatever the source art's orientation — portrait key art (1200×1600),
 * near-square art (1280×1440) and landscape art all fill the tile with no
 * themed strip showing. There is deliberately NO info block under the
 * cover: the title rides on a dark scrim at the cover's bottom edge and
 * the playtime is a badge ON the cover (img-chip, readable on photos in
 * both themes), never a row of its own. (The old layout — a 4:3 cover box
 * over a title+playtime block — left a pale strip under the first card's
 * cover in light mode whenever its art was shorter than its neighbours'.)
 */
function LibraryEntryGridCard({ entry, onOpen }: { entry: LibraryEntry; onOpen: (entry: LibraryEntry) => void }) {
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`查看游戏详情：${entry.title}`}
      onClick={() => onOpen(entry)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(entry);
        }
      }}
      className="relative aspect-[3/4] cursor-pointer overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] shadow-[var(--glass-hi)]"
    >
      <SafeImg src={entry.imageUrl} alt="" label={entry.title} phFontSize={30} className="absolute inset-0 h-full w-full object-cover" loading="lazy" decoding="async" />
      {entry.playtimeMinutes != null ? (
        <span className="img-chip absolute right-1.5 top-1.5 z-[2] rounded-full px-1.5 py-[3px] font-mono text-[9px] leading-none">
          {playtimeLabel(entry.playtimeMinutes)}
        </span>
      ) : null}
      {entry.devicePlatforms.length > 0 ? (
        <span className="absolute bottom-1.5 right-1.5 z-[2]">
          <DevicePlatformMarks platforms={entry.devicePlatforms} />
        </span>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] bg-gradient-to-t from-[rgba(5,8,20,0.82)] via-[rgba(5,8,20,0.38)] to-transparent px-2 pb-1.5 pt-7">
        <h4 className="line-clamp-2 text-[11px] font-bold leading-[1.25] text-white">{entry.title}</h4>
      </div>
    </article>
  );
}

function LibraryEntryCompactRow({ entry, onOpen }: { entry: LibraryEntry; onOpen: (entry: LibraryEntry) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看游戏详情：${entry.title}`}
      onClick={() => onOpen(entry)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(entry);
        }
      }}
      className="flex cursor-pointer items-center gap-2.5 border-b border-[var(--border)] py-2"
    >
      <h4 className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">{entry.title}</h4>
      <DevicePlatformMarks platforms={entry.devicePlatforms} />
      <span className="flex-none font-mono text-[9.5px] text-[var(--dim2)]">{playtimeLabel(entry.playtimeMinutes)}</span>
    </div>
  );
}

/**
 * Full-screen detail for one library game: everything the library actually
 * knows about it (cover, platform, real playtime + when it was refreshed,
 * how it entered the library, when) plus the official store link built
 * server-side from the identifiers captured at sync time.
 */
function LibraryGameDetail({
  entry,
  groupPlatform,
  playtimeNote,
  onClose,
  onRemoveClaimed,
  authToken,
}: {
  entry: LibraryEntry;
  groupPlatform: string;
  playtimeNote: string | null;
  onClose: () => void;
  onRemoveClaimed: (dealId: number) => void;
  authToken?: string;
}) {
  const { remove, pending } = useRemoveLibraryEntry(entry, authToken, onRemoveClaimed, onClose);
  const groupName = LIBRARY_GROUP_NAMES[groupPlatform] ?? groupPlatform;
  const storeName = groupPlatform === "epic" ? "Epic" : groupPlatform === "steam" ? "Steam" : groupPlatform === "gog" ? "GOG" : null;
  const ptUpdated = fmtDateTime(entry.playtimeUpdatedAt);
  const added = fmtDateTime(entry.addedAt);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Substantive content about the game itself (official intro, screenshots,
  // type / developer / publisher / release date) is fetched server-side from
  // the platform's official store page and cached; the library row alone
  // only knows title/cover/playtime.
  const detailQuery = useQuery({
    queryKey: ["libGameDetail", entry.itemId ?? 0, entry.dealId ?? 0],
    queryFn: () =>
      api.getLibraryGameDetail({
        itemId: entry.itemId ?? undefined,
        dealId: entry.dealId ?? undefined,
        authToken,
      }),
    enabled: entry.itemId != null || entry.dealId != null,
    staleTime: 5 * 60 * 1000,
  });
  const gd = detailQuery.data;
  const gdGallery = gd?.gallery ?? [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightbox != null) setLightbox(null);
        else onClose();
      }
      if (lightbox != null && gdGallery.length > 1) {
        if (e.key === "ArrowRight") setLightbox((i) => (i == null ? i : (i + 1) % gdGallery.length));
        if (e.key === "ArrowLeft") setLightbox((i) => (i == null ? i : (i - 1 + gdGallery.length) % gdGallery.length));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lightbox, gdGallery.length]);
  return (
    <div className="v-scroll-only fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={`游戏详情：${entry.title}`}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <div className="sticky top-0 z-10 bg-[var(--sticky-bg)] backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-3">
          <button
            type="button"
            aria-label="返回游戏库"
            onClick={onClose}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <span className="ml-3 font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-[var(--dim2)]">{groupName} · 游戏详情</span>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-14">
        {entry.imageUrl ? (
          <div className="relative aspect-[16/9] w-full overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--surface2)]">
            <SafeImg src={entry.imageUrl} alt={entry.title} label={entry.title} phFontSize={60} className="absolute inset-0 h-full w-full bg-[var(--surface2)] object-cover" />
          </div>
        ) : (
          <div aria-hidden="true" className="flex aspect-[16/9] w-full items-center justify-center rounded-[20px] border border-[var(--border)] bg-[var(--surface2)] font-serif text-6xl font-black text-[var(--dim2)]">
            {(entry.title.replace(/[《》]/g, "").trim()[0] ?? "游").toUpperCase()}
          </div>
        )}
        {gdGallery.length > 0 ? (
          <div className="mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="官方截图">
            {gdGallery.map((u, i) => (
              <button key={u} type="button" aria-label={`放大查看截图 ${i + 1}`} onClick={() => setLightbox(i)} className="aspect-[16/10] w-[148px] flex-none snap-start overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface2)] sm:w-[200px]">
                <SafeImg src={u} alt={`${entry.title} 官方截图 ${i + 1}`} label={entry.title} phFontSize={28} className="h-full w-full bg-[var(--surface2)] object-cover" loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        ) : null}
        <h1 className="mt-4 font-serif text-[24px] font-bold leading-[1.35] text-[var(--text)]">{entry.title}</h1>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className="rounded-[8px] border border-[var(--accent-border)] bg-[var(--accent-soft)] px-[7px] py-[5px] font-mono text-[9.5px] leading-none text-[var(--accent)]">{groupName}</span>
          <span className="rounded-[8px] border border-[var(--border)] px-[7px] py-[5px] font-mono text-[9.5px] leading-none text-[var(--dim)]">{libOriginLabel(entry.origin)}</span>
        </div>
        <dl className="mt-5 grid gap-2.5 rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-[var(--glass-hi)] backdrop-blur-md">
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-[var(--dim)]">平台</dt>
            <dd className="text-right text-[var(--text)]">{groupName}</dd>
          </div>
          {entry.devicePlatforms.length > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">可玩设备</dt>
              <dd className="text-right text-[var(--text)]">{entry.devicePlatforms.map((p) => (p === "pc" ? "电脑" : "手机")).join(" / ")}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-[var(--dim)]">游戏时长</dt>
            <dd className="text-right text-[var(--text)]">
              {entry.playtimeMinutes != null ? (
                <>
                  {playtimeLabel(entry.playtimeMinutes)}
                  {ptUpdated ? <span className="block text-xs text-[var(--dim2)]">更新于 {ptUpdated}</span> : null}
                </>
              ) : playtimeNote ? (
                <span className="text-[var(--dim)]">{playtimeNote}</span>
              ) : (
                "暂无时长记录"
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="shrink-0 text-[var(--dim)]">入库来源</dt>
            <dd className="text-right text-[var(--text)]">{libOriginLabel(entry.origin)}</dd>
          </div>
          {added ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">{entry.addedAtKind === "first-sync" ? "首次入库（同步）" : "入库时间"}</dt>
              <dd className="text-right text-[var(--text)]">
                {added}
                {entry.addedAtKind === "platform" ? <span className="block text-xs text-[var(--dim2)]">Epic 记录的获取日期</span> : null}
                {entry.addedAtKind === "first-sync" ? <span className="block text-xs text-[var(--dim2)]">平台不提供获取日期，以首次同步到本库为准</span> : null}
              </dd>
            </div>
          ) : null}
          {gd && gd.genres.length > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">游戏类型</dt>
              <dd className="text-right text-[var(--text)]">{gd.genres.join(" / ")}</dd>
            </div>
          ) : null}
          {gd?.developer ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">开发商</dt>
              <dd className="text-right text-[var(--text)]">{gd.developer}</dd>
            </div>
          ) : null}
          {gd?.publisher ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">发行商</dt>
              <dd className="text-right text-[var(--text)]">{gd.publisher}</dd>
            </div>
          ) : null}
          {gd?.releaseDate ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-[var(--dim)]">发行日期</dt>
              <dd className="text-right text-[var(--text)]">{gd.releaseDate}</dd>
            </div>
          ) : null}
        </dl>
        {detailQuery.isPending ? (
          <p className="mt-6 text-center text-sm text-[var(--dim)]">正在从官方商店读取这款游戏的介绍和截图…</p>
        ) : gd?.about ? (
          <section aria-label="游戏介绍" className="mt-7">
            <div className="flex items-baseline gap-2">
              <h2 className="font-serif text-[17px] font-bold text-[var(--text)]">游戏介绍</h2>
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--dim2)]">{gd.sourceLabel}</span>
            </div>
            <div className="mt-2.5 grid gap-3 text-[13.5px] leading-[1.85] text-[var(--dim)]">
              {gd.about.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="whitespace-pre-line">{para.trim()}</p>
              ))}
            </div>
          </section>
        ) : (
          <p className="mt-6 rounded-[14px] border border-dashed border-[var(--border)] px-4 py-4 text-center text-xs leading-relaxed text-[var(--dim2)]">
            官方商店暂时没有取到这款游戏的详细介绍{gd && gdGallery.length > 0 ? "，上方截图来自官方商店" : ""}，点下方按钮可以去商店页查看完整内容。
          </p>
        )}
        <div className="mt-8 grid gap-3">
          {entry.storeUrl && storeName ? (
            <a
              href={entry.storeUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`在 ${storeName} 打开 ${entry.title}`}
              className="cta-hard flex items-center justify-center gap-3 rounded-[14px] bg-grad px-4 py-[13px] text-center text-[15px] font-bold tracking-[0.04em] text-[var(--accent-ink)]"
            >
              在 {storeName} 打开 <span aria-hidden="true" className="font-mono text-base">→</span>
            </a>
          ) : null}
          <button
            type="button"
            aria-label={entry.origin === "claimed" ? `取消 ${entry.title} 的已领标记` : `从库中移除 ${entry.title}`}
            disabled={pending}
            onClick={remove}
            className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm font-medium text-[var(--warn)] backdrop-blur-md disabled:opacity-50"
          >
            {pending ? "处理中…" : entry.origin === "claimed" ? "取消已领标记" : "从库中移除"}
          </button>
        </div>
      </div>
      {lightbox != null && gdGallery[lightbox] ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label="截图预览">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="font-mono text-sm text-white/70">{lightbox + 1} / {gdGallery.length}</span>
            <button type="button" aria-label="关闭截图预览" onClick={() => setLightbox(null)} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg text-white">✕</button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-4">
            <SafeImg src={gdGallery[lightbox]} alt={`${entry.title} 官方截图 ${lightbox + 1}`} label={entry.title} phFontSize={40} className="max-h-full max-w-full rounded-lg object-contain" />
          </div>
          {gdGallery.length > 1 ? (
            <div className="flex items-center justify-center gap-6 pb-8">
              <button type="button" aria-label="上一张截图" onClick={() => setLightbox((lightbox - 1 + gdGallery.length) % gdGallery.length)} className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl text-white">‹</button>
              <button type="button" aria-label="下一张截图" onClick={() => setLightbox((lightbox + 1) % gdGallery.length)} className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl text-white">›</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MinePage({
  session,
  onSessionChange,
  onShowSaved,
  onOpenPrimeClaim,
  theme,
  onToggleTheme,
}: {
  session: Session | null;
  onSessionChange: (s: Session | null) => void;
  onShowSaved: () => void;
  onOpenPrimeClaim: () => void;
  theme: UiTheme;
  onToggleTheme: () => void;
}) {
  const queryClient = useQueryClient();
  const authToken = session?.token;
  // Keys carry the session identity (same pattern as primeQueue below):
  // a bare ["library"] key keeps serving the signed-out legacy-pool result
  // after login, because the refetch races the session state update and
  // runs with the old token-less closure.
  const accountsQuery = useQuery({ queryKey: ["accounts", session?.username ?? ""], queryFn: () => api.getAccounts({ authToken }) });
  const libraryQuery = useQuery({ queryKey: ["library", session?.username ?? ""], queryFn: () => api.listLibrary({ authToken }) });
  const primeQueueQuery = useQuery({
    queryKey: ["primeQueue", session?.username ?? ""],
    queryFn: () => api.listPrimeClaimQueue({ authToken }),
  });
  const [openPanel, setOpenPanel] = useState<PlatformKey | null>(null);
  const [loginGateMsg, setLoginGateMsg] = useState<string | null>(null);

  // --- account panel (opened by tapping the avatar on the account card):
  // the single home for account operations — avatar upload / reset and
  // password change. The card itself carries no other account links. ---
  const sessionUserQuery = useQuery({
    queryKey: ["sessionUser", session?.token ?? ""],
    queryFn: () => api.getSessionUser({ authToken: session?.token }),
    enabled: !!session,
  });
  const avatar = sessionUserQuery.data?.avatar ?? null;
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [avatarNote, setAvatarNote] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement | null>(null);
  const setAvatarMutation = useMutation({
    mutationFn: (a: { mode: "image" | "clear"; imageBase64?: string }) =>
      api.setAvatar({ authToken: session?.token ?? "", ...a }),
    onSuccess: (r) => {
      setAvatarNote(r.note);
      if (r.ok) queryClient.invalidateQueries({ queryKey: ["sessionUser"] });
    },
    onError: (e) => setAvatarNote(e instanceof Error ? e.message : String(e)),
  });
  // --- change password (verified server-side against the current hash) ---
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwNote, setPwNote] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const changePasswordMutation = useMutation({
    mutationFn: () =>
      api.changePassword({ authToken: session?.token ?? "", currentPassword: pwCurrent, newPassword: pwNew }),
    onSuccess: (r) => {
      setPwNote(r.note);
      setPwDone(r.ok);
      if (r.ok) {
        setPwCurrent("");
        setPwNew("");
        setPwConfirm("");
      }
    },
    onError: (e) => {
      setPwDone(false);
      setPwNote(e instanceof Error ? e.message : String(e));
    },
  });
  const submitPasswordChange = () => {
    setPwDone(false);
    if (pwNew.length < 6) {
      setPwNote("新密码至少 6 位");
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwNote("两次输入的新密码不一致");
      return;
    }
    changePasswordMutation.mutate();
  };
  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    setAvatarBusy(true);
    setAvatarNote(null);
    try {
      const dataUrl = await compressAvatarImage(file);
      setAvatarMutation.mutate({ mode: "image", imageBase64: dataUrl });
    } catch {
      setAvatarNote("这张图片读不了，换一张试试");
    } finally {
      setAvatarBusy(false);
    }
  };

  // --- in-app account (real registration / login) ---
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authNote, setAuthNote] = useState<string | null>(null);
  const authMutation = useMutation({
    mutationFn: () =>
      authMode === "register"
        ? api.registerAccount({ username: usernameInput.trim(), password: passwordInput })
        : api.loginAccount({ username: usernameInput.trim(), password: passwordInput }),
    onSuccess: (r) => {
      if (r.ok && r.token && r.username) {
        setAuthNote(null);
        setPasswordInput("");
        onSessionChange({ token: r.token, username: r.username });
        // The accounts/library/prime queries were fetched signed-out (the
        // legacy pool) under session-independent keys; without this they
        // keep serving the empty signed-out result after login until the
        // page happens to remount.
        queryClient.invalidateQueries({ queryKey: ["accounts"] });
        queryClient.invalidateQueries({ queryKey: ["library"] });
        queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
      } else {
        setAuthNote(r.note);
      }
    },
    onError: (e) => setAuthNote(e instanceof Error ? e.message : String(e)),
  });
  const logoutMutation = useMutation({
    mutationFn: () => api.logoutAccount({ authToken: authToken ?? "" }),
    onSettled: () => onSessionChange(null),
  });

  const invalidateAccountData = () => {
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
    queryClient.invalidateQueries({ queryKey: ["library"] });
    queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
  };

  const syncPlatform = useMutation({
    mutationFn: (platform: PlatformKey) => api.syncPlatformLibrary({ platform, authToken }),
    onSuccess: () => { invalidateAccountData(); },
  });
  const unbind = useMutation({
    mutationFn: (platform: PlatformKey) => api.unbindPlatform({ platform, authToken }),
    onSuccess: (_r, platform) => {
      setOpenPanel((cur) => (cur === platform ? null : cur));
      invalidateAccountData();
    },
  });
  const unclaim = useMutation({
    mutationFn: (dealId: number) => api.toggleMark({ dealId, kind: "claimed", authToken }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
    },
  });

  // --- library view mode / sort / folded groups (remembered per account server-side) ---
  const [libView, setLibView] = useState<LibView>("list");
  const [libSort, setLibSort] = useState<LibSort>("default");
  const [libFolded, setLibFolded] = useState<LibGroupKey[]>([]);
  const prefsOwnerRef = useRef<string | null>(null);
  // Set the moment the user picks a view/sort in THIS mount. The prefs
  // effect below must never overwrite a choice the user just made — the
  // concrete failure: open 我的, change the sort while the library query
  // is still loading, and the arriving server prefs (the OLD value) snap
  // the select and the list back, making the sort look dead.
  const libPrefsTouchedRef = useRef(false);
  const [libGame, setLibGame] = useState<{ entry: LibraryEntry; group: string } | null>(null);
  const [ptNotes, setPtNotes] = useState<string[] | null>(null);
  const savePrefs = useMutation({
    mutationFn: (p: { view: LibView; sort: LibSort; folded: LibGroupKey[] }) => api.saveLibraryPrefs({ ...p, authToken }),
  });
  const applyLibPrefs = (view: LibView, sort: LibSort, folded: LibGroupKey[] = libFolded) => {
    libPrefsTouchedRef.current = true;
    setLibView(view);
    setLibSort(sort);
    setLibFolded(folded);
    if (session) savePrefs.mutate({ view, sort, folded });
  };
  const toggleLibFold = (platform: LibGroupKey) => {
    applyLibPrefs(libView, libSort, libFolded.includes(platform) ? libFolded.filter((g) => g !== platform) : [...libFolded, platform]);
  };
  const refreshPt = useMutation({
    mutationFn: () => api.refreshPlaytimes({ authToken }),
    onSuccess: (r) => {
      setPtNotes(r.results.filter((x) => x.state !== "not-bound").map((x) => `${PLATFORM_NAMES[x.platform]}：${x.note}`));
      queryClient.invalidateQueries({ queryKey: ["library"] });
    },
    onError: (e) => setPtNotes([e instanceof Error ? e.message : String(e)]),
  });
  useEffect(() => {
    const prefs = libraryQuery.data?.prefs;
    if (!prefs) return;
    if (libPrefsTouchedRef.current) return;
    const owner = session?.username ?? "guest";
    if (prefsOwnerRef.current === owner) return;
    prefsOwnerRef.current = owner;
    setLibView(prefs.view);
    setLibSort(prefs.sort);
    setLibFolded(prefs.folded.filter((g): g is LibGroupKey => g === "epic" || g === "steam" || g === "gog" || g === "amazon" || g === "legacy"));
  }, [libraryQuery.data?.prefs, session?.username]);

  const data = accountsQuery.data;
  const groups = libraryQuery.data?.groups ?? [];
  const playtimeStatus = libraryQuery.data?.playtimeStatus ?? [];
  const primeLeft = primeQueueQuery.data?.items.length ?? 0;
  const openStatus = openPanel ? (data?.platforms ?? []).find((s) => s.platform === openPanel) ?? null : null;

  const gateOrToggle = (platform: PlatformKey) => {
    if (!session) {
      setLoginGateMsg("先登录站内账号：登录后绑定会记在你的账号名下，换设备登录同一账号就能恢复。");
      return;
    }
    setLoginGateMsg(null);
    setOpenPanel((cur) => (cur === platform ? null : platform));
  };

  const inputCls = "w-full rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm text-[var(--text)] outline-none backdrop-blur-md focus:border-[var(--accent)]";

  return (
    <div>
      <div className="flex items-baseline gap-2 pb-1 pt-4">
        <h1 className="font-serif text-[26px] font-black leading-none text-[var(--text)]">我的</h1>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--dim2)]">ACCOUNT &amp; LIBRARY</span>
      </div>

      {/* in-app account */}
      <SectionHead no="01" title="站内账号" en="ACCOUNT" right={<ThemeToggleButton theme={theme} onToggle={onToggleTheme} />} />
      {session ? (
        <section className="rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-3.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="账号操作：更换头像、修改密码"
              aria-haspopup="dialog"
              aria-expanded={accountPanelOpen}
              onClick={() => setAccountPanelOpen(true)}
              className="flex-none rounded-full"
            >
              <AvatarBadge username={session.username} avatar={avatar} size={52} />
            </button>
            <p className="min-w-0 flex-1 truncate font-serif text-[17px] font-bold text-[var(--text)]">{session.username}</p>
            <div className="flex w-[104px] flex-none flex-col gap-2">
              <button
                type="button"
                aria-label="退出登录"
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
                className="w-full rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-[13px] font-medium text-[var(--dim)] backdrop-blur-md disabled:opacity-50"
              >
                退出登录
              </button>
              <button
                type="button"
                aria-label="查看我的收藏"
                onClick={onShowSaved}
                className="w-full rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-[13px] font-medium text-[var(--text)] backdrop-blur-md"
              >
                我的收藏
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-4">
          <div className="mb-3.5 flex gap-2" role="group" aria-label="登录或注册">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={authMode === m}
                aria-label={m === "login" ? "切换到登录" : "切换到注册"}
                onClick={() => {
                  setAuthMode(m);
                  setAuthNote(null);
                }}
                className={`flex-1 border px-3 py-2 text-[13px] font-bold ${authMode === m ? "border-transparent bg-grad text-[var(--accent-ink)]" : "border-[var(--border)] text-[var(--dim)]"}`}
              >
                {m === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (usernameInput.trim().length >= 2 && passwordInput.length >= 6) authMutation.mutate();
            }}
            className="grid gap-3"
          >
            <div>
              <label htmlFor="auth-username" className="text-xs font-medium text-[var(--dim)]">用户名</label>
              <input
                id="auth-username"
                aria-label="用户名"
                autoComplete="username"
                className={`${inputCls} mt-1`}
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="至少 2 个字符"
              />
            </div>
            <div>
              <label htmlFor="auth-password" className="text-xs font-medium text-[var(--dim)]">密码</label>
              <input
                id="auth-password"
                aria-label="密码"
                type="password"
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
                className={`${inputCls} mt-1`}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="至少 6 位"
              />
            </div>
            {authMode === "register" ? (
              <p className="text-xs leading-relaxed text-[var(--dim2)]">没有邮箱找回：密码忘了无法找回，请牢记。</p>
            ) : null}
            {authNote ? <p className="text-xs font-medium leading-[1.7] text-[var(--warn)]">{authNote}</p> : null}
            <button
              type="submit"
              aria-label={authMode === "register" ? "注册站内账号" : "登录站内账号"}
              disabled={authMutation.isPending || usernameInput.trim().length < 2 || passwordInput.length < 6}
              className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
            >
              {authMutation.isPending ? "处理中…" : authMode === "register" ? "注册并登录" : "登录"}
            </button>
          </form>
        </section>
      )}

      {/* account panel: opened by tapping the avatar; the only home for
          avatar upload/reset and password change */}
      {session && accountPanelOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="账号操作">
          <button
            type="button"
            aria-label="关闭账号操作面板"
            className="absolute inset-0 bg-black/55"
            onClick={() => setAccountPanelOpen(false)}
          />
          <div className="v-scroll-only relative max-h-[86vh] w-full max-w-md rounded-t-[22px] border border-[var(--glass-edge)] shadow-[var(--shadow)]">
            <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-[var(--glass-edge-strong)]" aria-hidden="true" />
            <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
              <div className="flex items-center gap-3">
                <AvatarBadge username={session.username} avatar={avatar} size={44} />
                <p className="min-w-0 flex-1 truncate font-serif text-[16px] font-bold text-[var(--text)]">{session.username}</p>
                <button
                  type="button"
                  aria-label="关闭账号操作面板"
                  onClick={() => setAccountPanelOpen(false)}
                  className="grid h-9 w-9 flex-none place-items-center rounded-full border border-[var(--glass-edge)] bg-[var(--surface)] text-lg leading-none text-[var(--text)] shadow-[var(--glass-hi)] backdrop-blur-md"
                >
                  ×
                </button>
              </div>

              <p className="mt-5 text-xs font-semibold text-[var(--dim)]">更换头像</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-label="从相册上传头像照片"
                  disabled={setAvatarMutation.isPending || avatarBusy}
                  onClick={() => avatarFileRef.current?.click()}
                  className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
                >
                  {avatarBusy ? "处理中…" : "从相册上传照片"}
                </button>
                {avatar ? (
                  <button
                    type="button"
                    aria-label="恢复默认头像"
                    disabled={setAvatarMutation.isPending || avatarBusy}
                    onClick={() => setAvatarMutation.mutate({ mode: "clear" })}
                    className="rounded-[14px] border border-[var(--border)] bg-[var(--surface2)] px-4 py-2.5 text-sm font-medium text-[var(--dim)] backdrop-blur-md disabled:opacity-50"
                  >
                    恢复默认头像
                  </button>
                ) : null}
                <input
                  ref={avatarFileRef}
                  type="file"
                  accept="image/*"
                  aria-label="选择头像图片文件"
                  className="hidden"
                  onChange={(e) => {
                    void handleAvatarFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              {avatarNote ? <p className="mt-2 text-xs font-medium leading-[1.7] text-[var(--dim)]">{avatarNote}</p> : null}

              <div className="mt-6 border-t border-[var(--border)] pt-5">
                <p className="text-xs font-semibold text-[var(--dim)]">修改密码</p>
                <form
                  className="mt-3 grid gap-3"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    submitPasswordChange();
                  }}
                >
                  <div>
                    <label htmlFor="pw-current" className="text-xs font-medium text-[var(--dim)]">当前密码</label>
                    <input
                      id="pw-current"
                      aria-label="当前密码"
                      type="password"
                      autoComplete="current-password"
                      className={`${inputCls} mt-1`}
                      value={pwCurrent}
                      onChange={(e) => setPwCurrent(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="pw-new" className="text-xs font-medium text-[var(--dim)]">新密码</label>
                    <input
                      id="pw-new"
                      aria-label="新密码"
                      type="password"
                      autoComplete="new-password"
                      className={`${inputCls} mt-1`}
                      value={pwNew}
                      onChange={(e) => setPwNew(e.target.value)}
                      placeholder="至少 6 位"
                    />
                  </div>
                  <div>
                    <label htmlFor="pw-confirm" className="text-xs font-medium text-[var(--dim)]">再输入一次新密码</label>
                    <input
                      id="pw-confirm"
                      aria-label="再输入一次新密码"
                      type="password"
                      autoComplete="new-password"
                      className={`${inputCls} mt-1`}
                      value={pwConfirm}
                      onChange={(e) => setPwConfirm(e.target.value)}
                    />
                  </div>
                  {pwNote ? (
                    <p className={`text-xs font-medium leading-[1.7] ${pwDone ? "text-[var(--free-ink)]" : "text-[var(--warn)]"}`}>{pwNote}</p>
                  ) : null}
                  <button
                    type="submit"
                    aria-label="确认修改密码"
                    disabled={changePasswordMutation.isPending || !pwCurrent || !pwNew || !pwConfirm}
                    className="rounded-[14px] bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
                  >
                    {changePasswordMutation.isPending ? "处理中…" : "确认修改"}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* platform bindings — compact small cards, one row of three */}
      <SectionHead no="02" title="平台账号" en="GAME ACCOUNTS" />
      <div className="grid grid-cols-3 gap-2">
        {(data?.platforms ?? []).map((status) => {
          const group = groups.find((g) => g.platform === status.platform);
          const totalInLibrary = group?.entries.length ?? 0;
          const isOpen = openPanel === status.platform;
          return (
            <div
              key={status.platform}
              className={`rounded-[16px] border bg-[var(--surface)] px-2.5 py-2.5 shadow-[var(--glass-hi)] backdrop-blur-md ${isOpen ? "border-[var(--accent-border)]" : "border-[var(--border)]"}`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-[7px] w-[7px] flex-none rounded-full"
                  style={{ backgroundColor: status.bound ? "var(--free-ink)" : "var(--dim2)" }}
                />
                <h3 className="truncate font-serif text-[15px] font-bold leading-tight text-[var(--text)]">{PLATFORM_NAMES[status.platform]}</h3>
              </div>
              <p className="mt-1 truncate text-[11px] leading-tight text-[var(--dim)]">
                {status.bound ? `${status.displayName ?? "已绑定"} · ${totalInLibrary} 款` : "未绑定"}
              </p>
              <button
                type="button"
                aria-label={status.bound ? `管理 ${PLATFORM_NAMES[status.platform]} 绑定` : `登录绑定 ${PLATFORM_NAMES[status.platform]}`}
                aria-expanded={isOpen}
                onClick={() => gateOrToggle(status.platform)}
                className={`mt-2 w-full px-1 py-1.5 text-[11px] font-bold ${status.bound ? "rounded-[10px] border border-[var(--border)] text-[var(--dim)]" : "rounded-[10px] bg-grad text-[var(--accent-ink)]"}`}
              >
                {status.bound ? "管理" : "登录绑定"}
              </button>
            </div>
          );
        })}
        {accountsQuery.isPending ? <p className="col-span-3 py-4 text-center text-sm text-[var(--dim)]">加载中…</p> : null}
      </div>
      {loginGateMsg ? <p className="mt-2.5 text-xs font-medium leading-[1.7] text-[var(--warn)]">{loginGateMsg}</p> : null}
      {openStatus && data ? (
        <section aria-label={`${PLATFORM_NAMES[openStatus.platform]} 绑定管理`} className="mt-2.5 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-4">
          <div className="flex items-center gap-2.5">
            <h3 className="min-w-0 flex-1 truncate font-serif text-[15px] font-bold text-[var(--text)]">
              {PLATFORM_NAMES[openStatus.platform]}
              <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                {openStatus.bound ? `${openStatus.displayName ?? "已绑定"}${openStatus.platform === "steam" && openStatus.accountRef ? ` · ${openStatus.accountRef}` : ""}` : "未绑定"}
              </span>
            </h3>
            {openStatus.bound ? (
              <>
                <button
                  type="button"
                  aria-label={`同步 ${PLATFORM_NAMES[openStatus.platform]} 游戏库`}
                  disabled={syncPlatform.isPending}
                  onClick={() => syncPlatform.mutate(openStatus.platform)}
                  className="flex-none rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-3 py-1.5 text-xs font-bold text-[var(--text)] disabled:opacity-50"
                >
                  {syncPlatform.isPending && syncPlatform.variables === openStatus.platform ? "同步中…" : "同步"}
                </button>
                <button
                  type="button"
                  aria-label={`解绑 ${PLATFORM_NAMES[openStatus.platform]} 账号`}
                  disabled={unbind.isPending}
                  onClick={() => unbind.mutate(openStatus.platform)}
                  className="flex-none px-1.5 py-1.5 text-xs font-medium text-[var(--warn)] disabled:opacity-50"
                >
                  解绑
                </button>
              </>
            ) : null}
          </div>
          <div className="bind-clean mt-3 border-t border-[var(--border)] pt-3.5">
            <PlatformLoginPanel
              platform={openStatus.platform}
              status={openStatus}
              loginUrl={openStatus.platform === "epic" ? data.loginUrls.epic : openStatus.platform === "gog" ? data.loginUrls.gog : null}
              onDone={invalidateAccountData}
              onBound={() => setOpenPanel(null)}
              authToken={authToken}
            />
          </div>
        </section>
      ) : null}

      {/* prime one-click claim */}
      <SectionHead no="03" title="Prime 一键领取" en="PRIME CLAIM" />
      <section className="flex items-center gap-3 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold leading-tight text-[var(--text)]">一键领取 Prime 游戏</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
            {primeQueueQuery.isPending ? "读取未领清单中…" : primeLeft > 0 ? `${primeLeft} 款未领，按截止日排队` : "当前没有未领的 Prime 游戏"}
          </p>
        </div>
        <button
          type="button"
          aria-label="打开 Prime 一键领取队列"
          onClick={onOpenPrimeClaim}
          className="cta-hard flex-none bg-grad px-4 py-2.5 text-[13px] font-bold text-[var(--accent-ink)]"
        >
          一键领取
        </button>
      </section>

      {/* library */}
      <SectionHead no="04" title="游戏库" en="MY LIBRARY" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full bg-[var(--seg-track)] p-1 backdrop-blur-md" role="group" aria-label="游戏库展示方式">
          {(
            [
              { key: "list", label: "列表" },
              { key: "grid", label: "网格" },
              { key: "compact", label: "紧凑" },
            ] as { key: LibView; label: string }[]
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={libView === v.key}
              aria-label={`游戏库按${v.label}展示`}
              onClick={() => applyLibPrefs(v.key, libSort)}
              className={`rounded-full px-3 py-1.5 text-[11px] leading-none transition-colors ${libView === v.key ? "bg-grad font-bold text-[var(--accent-ink)]" : "font-medium text-[var(--dim)]"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="lib-sort">游戏库排序</label>
        <select
          id="lib-sort"
          aria-label="游戏库排序"
          value={libSort}
          onChange={(e) => applyLibPrefs(libView, e.target.value as LibSort)}
          className="rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-[7px] text-[11px] font-medium text-[var(--dim)] backdrop-blur-md"
        >
          <option value="default">默认排序</option>
          <option value="playtime">按游戏时长</option>
          <option value="name">按名称</option>
          <option value="recent">按最近入库</option>
        </select>
        <button
          type="button"
          aria-label="更新游戏时长"
          disabled={refreshPt.isPending}
          onClick={() => refreshPt.mutate()}
          className="rounded-full border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-[7px] text-[11px] font-bold leading-none text-[var(--accent)] backdrop-blur-md disabled:opacity-50"
        >
          {refreshPt.isPending ? "更新中…" : "↻ 更新时长"}
        </button>
        {groups.length > 0 ? (
          <button
            type="button"
            aria-label={groups.every((g) => libFolded.includes(g.platform)) ? "全部展开游戏库分组" : "全部折叠游戏库分组"}
            onClick={() =>
              applyLibPrefs(
                libView,
                libSort,
                groups.every((g) => libFolded.includes(g.platform)) ? [] : groups.map((g) => g.platform),
              )
            }
            className="rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-[7px] text-[11px] font-medium leading-none text-[var(--dim)] backdrop-blur-md"
          >
            {groups.every((g) => libFolded.includes(g.platform)) ? "全部展开" : "全部折叠"}
          </button>
        ) : null}
      </div>
      {ptNotes ? (
        <div className="mb-3 grid gap-1">
          {ptNotes.map((n) => (
            <p key={n} className="text-xs leading-[1.7] text-[var(--dim)]">{n}</p>
          ))}
        </div>
      ) : null}
      <div className="grid gap-6">
        {groups.map((group) => {
          const sorted = sortLibEntries(group.entries, libSort);
          const ptStatus = playtimeStatus.find((s) => s.platform === group.platform);
          const folded = libFolded.includes(group.platform);
          const groupName = LIBRARY_GROUP_NAMES[group.platform] ?? group.platform;
          return (
            <section key={group.platform} aria-label={`${groupName} 游戏库`}>
              <div className="mb-2.5 flex items-center gap-2">
                <button
                  type="button"
                  aria-expanded={!folded}
                  aria-label={`${folded ? "展开" : "收起"}${groupName}游戏库`}
                  onClick={() => toggleLibFold(group.platform)}
                  className="flex items-center gap-1.5"
                >
                  <h3 className="font-serif text-[16px] font-bold text-[var(--text)]">{groupName}</h3>
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className={`h-4 w-4 flex-none text-[var(--dim2)] transition-transform duration-200 ${folded ? "-rotate-90" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                <span className="font-mono text-[10px] text-[var(--dim2)]">{group.entries.length} 款</span>
              </div>
              {folded ? null : (
                <>
              {ptStatus?.state === "unsupported" && group.entries.length > 0 ? (
                <p className="mb-2 text-[11px] leading-relaxed text-[var(--dim2)]">该平台暂不支持时长同步{ptStatus.note ? `（${ptStatus.note.replace(/^该平台暂不支持时长同步（|）$/g, "")}）` : ""}</p>
              ) : null}
              {sorted.length > 0 ? (
                libView === "grid" ? (
                  <div className="grid grid-cols-3 gap-2">
                    {sorted.map((entry) => (
                      <LibraryEntryGridCard key={entry.key} entry={entry} onOpen={(e) => setLibGame({ entry: e, group: group.platform })} />
                    ))}
                  </div>
                ) : libView === "compact" ? (
                  <div>
                    {sorted.map((entry) => (
                      <LibraryEntryCompactRow key={entry.key} entry={entry} onOpen={(e) => setLibGame({ entry: e, group: group.platform })} />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-[9px]">
                    {sorted.map((entry) => (
                      <LibraryEntryRow key={entry.key} entry={entry} authToken={authToken} onOpen={(e) => setLibGame({ entry: e, group: group.platform })} onRemoveClaimed={(dealId) => unclaim.mutate(dealId)} />
                    ))}
                  </div>
                )
              ) : (
                <p className="rounded-[14px] border border-dashed border-[var(--border)] px-4 py-5 text-center text-xs text-[var(--dim2)]">
                  绑定账号并同步后，这里会出现你的游戏
                </p>
              )}
                </>
              )}
            </section>
          );
        })}
        {libraryQuery.isPending ? <p className="py-6 text-center text-sm text-[var(--dim)]">加载中…</p> : null}
      </div>
      {libGame ? (
        <LibraryGameDetail
          entry={libGame.entry}
          groupPlatform={libGame.group}
          authToken={authToken}
          playtimeNote={playtimeStatus.find((s) => s.platform === libGame.group && s.state === "unsupported")?.note ?? null}
          onClose={() => setLibGame(null)}
          onRemoveClaimed={(dealId) => unclaim.mutate(dealId)}
        />
      ) : null}
    </div>
  );
}

// ---------- prime one-click claim flow ----------

type PrimeQueueItem = ApiResponse<typeof api, "listPrimeClaimQueue">["items"][number];

/**
 * One-click Prime claim, as a guided queue. Amazon passwords are typed ONLY
 * on Amazon's own pages — this flow never shows an Amazon credential field.
 * Channel reality (server-tested): Epic games have NO code — with the Epic
 * account linked on Amazon's side, claiming there grants straight into the
 * Epic library, so the queue's 「检测入库」 syncs the bound Epic library and
 * auto-records the claim only when the game verifiably arrived. GOG games
 * come as a code: the user pastes it here and redeemPrimeGogCode calls GOG's
 * official bonus-code API with the bound GOG token, verifying arrival in the
 * synced GOG library before marking anything claimed.
 */
function PrimeClaimFlow({
  session,
  now,
  onClose,
  onGoLogin,
  onShowLibrary,
  onGoBind,
}: {
  session: Session | null;
  now: number;
  onClose: () => void;
  onGoLogin: () => void;
  onShowLibrary: () => void;
  onGoBind: () => void;
}) {
  const queryClient = useQueryClient();
  const authToken = session?.token;
  const queueQuery = useQuery({
    queryKey: ["primeQueue", session?.username ?? ""],
    queryFn: () => api.listPrimeClaimQueue({ authToken }),
    enabled: !!session,
  });
  const [phase, setPhase] = useState<"amazon" | "queue" | "done">("amazon");
  const [snapshot, setSnapshot] = useState<PrimeQueueItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [claimedCount, setClaimedCount] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [gogCode, setGogCode] = useState("");
  const [redeemResult, setRedeemResult] = useState<{ state: string; fallbackUrl: string | null } | null>(null);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    if (snapshot == null && queueQuery.data) {
      setSnapshot(queueQuery.data.items);
    }
  }, [queueQuery.data, snapshot]);

  // Per-item scratch state (GOG code draft, redeem outcome) resets per game.
  useEffect(() => {
    setGogCode("");
    setRedeemResult(null);
  }, [index]);

  const openExternal = (url: string) => {
    try {
      const w = window.open(url, "_blank");
      if (w) popupRef.current = w;
    } catch {
      // popup blocked — the anchor fallback in the panel still works
    }
  };

  const claimMutation = useMutation({
    mutationFn: (item: PrimeQueueItem) => api.claimPrimeGame({ dealId: item.dealId, authToken }),
    onSuccess: (r, item) => {
      setClaimedCount((c) => c + 1);
      setFeedback(r.ok ? `《${item.title}》已按 ${item.channelLabel} 渠道记入游戏库` : r.note);
      setIndex((i) => i + 1);
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["library"] });
      queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
    },
    onError: (e) => setFeedback(`标记失败：${e instanceof Error ? e.message : String(e)}`),
  });

  const autoCheck = useMutation({
    mutationFn: (item: PrimeQueueItem) => api.attemptPrimeAutoClaim({ dealId: item.dealId, authToken }),
    onSuccess: (r) => {
      setFeedback(r.note);
      if (r.ok) {
        setClaimedCount((c) => c + 1);
        setIndex((i) => i + 1);
        queryClient.invalidateQueries({ queryKey: ["deals"] });
        queryClient.invalidateQueries({ queryKey: ["library"] });
        queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
      }
    },
    onError: (e) => setFeedback(`检测失败：${e instanceof Error ? e.message : String(e)}`),
  });

  const redeemMutation = useMutation({
    mutationFn: (item: PrimeQueueItem) => api.redeemPrimeGogCode({ dealId: item.dealId, code: gogCode.trim(), authToken }),
    onSuccess: (r) => {
      setFeedback(r.note);
      setRedeemResult({ state: r.state, fallbackUrl: r.fallbackUrl });
      if (r.ok) {
        setClaimedCount((c) => c + 1);
        setIndex((i) => i + 1);
        queryClient.invalidateQueries({ queryKey: ["deals"] });
        queryClient.invalidateQueries({ queryKey: ["library"] });
        queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
      }
    },
    onError: (e) => setFeedback(`自动兑换失败：${e instanceof Error ? e.message : String(e)}`),
  });

  const items = snapshot ?? [];
  const total = items.length;
  const current = index < total ? items[index] : null;
  const finished = phase === "done" || (snapshot != null && index >= total && phase === "queue");
  const currentCd = current ? countdown(current.endAt, now) : null;
  const epicBound = queueQuery.data?.epicBound ?? false;
  const gogBound = queueQuery.data?.gogBound ?? false;
  const hasEpicItems = items.some((i) => i.channel === "epic");
  const hasGogItems = items.some((i) => i.channel === "gog");

  return (
    <div className="v-scroll-only fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="一键领取 Prime 游戏">
      <div className="mx-auto w-full max-w-3xl px-[22px] pb-[92px]">
        <div className="flex items-center gap-3 pb-2 pt-5">
          <button
            type="button"
            aria-label="关闭一键领取"
            onClick={onClose}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-base text-[var(--text)]"
          >
            ←
          </button>
          <h2 className="font-serif text-xl font-black text-[var(--text)]">一键领取 Prime 游戏</h2>
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-[var(--dim2)]">PRIME CLAIM</span>
        </div>

        {!session ? (
          <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-5 text-center">
            <p className="font-serif text-[16px] font-bold text-[var(--text)]">先登录站内账号</p>
            <p className="mx-auto mt-2 max-w-[42ch] text-[13px] leading-[1.8] text-[var(--dim)]">领取记录和入库渠道会记在你的账号名下，退出再登录也不会丢。</p>
            <button type="button" aria-label="去登录站内账号" onClick={onGoLogin} className="cta-hard mt-4 bg-grad px-5 py-2.5 text-sm font-bold text-[var(--accent-ink)]">
              去登录
            </button>
          </section>
        ) : phase === "amazon" && !finished ? (
          <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-5">
            <p className="font-serif text-[16px] font-bold text-[var(--text)]">第一步：在亚马逊官网登录 Prime 账号</p>
            <p className="mt-2 text-[13px] leading-[1.8] text-[var(--dim)]">
              点下面按钮打开亚马逊官方页，在官网里输你的 Prime 账号密码登录——密码只输在亚马逊官网，这里不会出现亚马逊密码输入框。登录好后回来点「开始领取」，队列会按截止日逐款打开官方领取页。
            </p>
            <div className="mt-4 grid gap-2.5">
              <button type="button" aria-label="打开亚马逊官方登录页" onClick={() => openExternal(AMAZON_HOME_URL)} className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-3 text-sm font-bold text-[var(--text)]">
                打开亚马逊官方页登录 →
              </button>
              <button
                type="button"
                aria-label="已在亚马逊登录，开始领取"
                disabled={queueQuery.isPending || snapshot == null}
                onClick={() => setPhase(total > 0 ? "queue" : "done")}
                className="cta-hard bg-grad px-4 py-3 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
              >
                {queueQuery.isPending || snapshot == null ? "读取未领清单中…" : total > 0 ? `已登录，开始领取（${total} 款未领）` : "已登录，查看结果"}
              </button>
            </div>
            <p className="mt-3.5 text-xs leading-[1.7] text-[var(--dim2)]">
              渠道说明：Epic 渠道没有兑换码——先在亚马逊领取页关联 Epic 账号，点领取后游戏自动发放进 Epic 库，回队列点「检测入库」即可核对到账、自动记入游戏库；GOG 渠道会给兑换码，把码粘贴进队列条目点「自动兑换」，就用你绑定的 GOG 授权直接兑换入库（接口拒绝时会原样显示 GOG 的错误）。
            </p>
          </section>
        ) : finished ? (
          <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-5 text-center">
            <p className="font-serif text-[16px] font-bold text-[var(--text)]">{claimedCount > 0 ? `本轮已领 ${claimedCount} 款` : "没有待领的了"}</p>
            <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-[1.8] text-[var(--dim)]">
              {claimedCount > 0 ? "领到的游戏已按入库渠道（Epic / GOG / Amazon Games App / Legacy Games）记入「我的」游戏库，并标记为已领。" : "清单里的 Prime 游戏都已领过，或目前没有在领取期内的新游戏。"}
            </p>
            {feedback ? <p className="mx-auto mt-2 max-w-[46ch] text-xs leading-[1.7] text-[var(--dim)]">{feedback}</p> : null}
            <div className="mt-4 flex justify-center gap-2.5">
              <button type="button" aria-label="查看我的游戏库" onClick={onShowLibrary} className="cta-hard bg-grad px-5 py-2.5 text-sm font-bold text-[var(--accent-ink)]">
                看游戏库
              </button>
              <button type="button" aria-label="关闭一键领取" onClick={onClose} className="border border-[var(--border)] px-5 py-2.5 text-sm font-medium text-[var(--dim)]">
                关闭
              </button>
            </div>
          </section>
        ) : current ? (
          <section className="mt-4">
            {hasEpicItems || hasGogItems ? (
              <div className="mb-3 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-3.5">
                <p className="font-serif text-[13px] font-bold text-[var(--text)]">关联检查 · 先看这里</p>
                {hasEpicItems ? (
                  <p className="mt-1.5 text-xs leading-[1.7] text-[var(--dim)]">
                    Epic 渠道：先在亚马逊领取页关联 Epic 账号，领取后自动进 Epic 库，没有兑换码。
                    {epicBound ? "空间里已绑定 Epic，可用每款的「检测入库」核对到账。" : "空间里还没绑定 Epic——「检测入库」需要先绑定，去「我的 → 平台账号」绑定。"}
                  </p>
                ) : null}
                {hasGogItems ? (
                  <p className="mt-1.5 text-xs leading-[1.7] text-[var(--dim)]">
                    GOG 渠道：在亚马逊领取页拿到兑换码，粘贴进条目点「自动兑换」即入库。
                    {gogBound ? "空间里已绑定 GOG，可直接自动兑换。" : "空间里还没绑定 GOG，未绑定时点「自动兑换」会先引导去绑定。"}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--dim2)]">
              <span>领取进度 / PROGRESS</span>
              <span className="text-[var(--accent)]">{Math.min(index + 1, total)} / {total}</span>
            </div>
            <div className="mt-2 h-[3px] bg-[var(--border)]">
              <div className="h-full bg-grad transition-all duration-500" style={{ width: `${total > 0 ? (index / total) * 100 : 0}%` }} />
            </div>
            <div className="mt-4 overflow-hidden rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md">
              {current.imageUrl ? (
                <SafeImg src={current.imageUrl} alt="" label={current.title} phFontSize={44} className="h-[168px] w-full bg-[var(--surface2)] object-cover" loading="lazy" decoding="async" />
              ) : null}
              <div className="p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="border border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-1 font-mono text-[9.5px] font-semibold text-[var(--accent-strong)]">入库渠道 · {current.channelLabel}</span>
                  {currentCd ? <span className="border border-[var(--border)] px-1.5 py-1 font-mono text-[9.5px] text-[var(--dim)]">{currentCd.text}截止</span> : null}
                </div>
                <h3 className="mt-2.5 font-serif text-lg font-bold leading-snug text-[var(--text)]">{current.titleZh?.trim() || current.title}</h3>
                {current.channel === "epic" ? (
                  <p className="mt-2 text-xs leading-[1.7] text-[var(--dim)]">先在亚马逊领取页关联 Epic 账号，领取后自动进 Epic 库（没有兑换码）。在亚马逊点完领取，回来点下方「检测入库」：同步你绑定的 Epic 库查到这款，就自动记入游戏库。</p>
                ) : null}
                {current.channel === "gog" ? (
                  <p className="mt-2 text-xs leading-[1.7] text-[var(--dim)]">GOG 渠道领的是兑换码：在亚马逊领取页复制兑换码，粘贴到下面点「自动兑换」，用你绑定的 GOG 授权直接兑换进你的 GOG 账号，到账验证后自动记入游戏库。</p>
                ) : null}
                <div className="mt-3.5 grid gap-2.5">
                  {current.claimUrl ? (
                    <a
                      href={current.claimUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`打开《${current.title}》的官方领取页`}
                      className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-4 py-3 text-center text-sm font-bold text-[var(--text)]"
                    >
                      打开官方领取页 →
                    </a>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`《${current.title}》已领，下一款`}
                    disabled={claimMutation.isPending}
                    onClick={() => claimMutation.mutate(current)}
                    className="cta-hard bg-grad px-4 py-3 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
                  >
                    {claimMutation.isPending ? "记录中…" : index + 1 >= total ? "已领，完成" : "已领，下一款"}
                  </button>
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      aria-label={`跳过《${current.title}》`}
                      disabled={claimMutation.isPending}
                      onClick={() => {
                        setFeedback(null);
                        setIndex((i) => i + 1);
                      }}
                      className="flex-1 border border-[var(--border)] px-3 py-2.5 text-[13px] font-medium text-[var(--dim)] disabled:opacity-50"
                    >
                      跳过这款
                    </button>
                    {current.channel === "epic" ? (
                      <button
                        type="button"
                        aria-label={`检测《${current.title}》是否已进 Epic 库`}
                        disabled={autoCheck.isPending}
                        onClick={() => autoCheck.mutate(current)}
                        className="flex-1 border border-[var(--border)] px-3 py-2.5 text-[13px] font-medium text-[var(--dim)] disabled:opacity-50"
                      >
                        {autoCheck.isPending ? "检测中…" : "检测入库"}
                      </button>
                    ) : null}
                  </div>
                  {current.channel === "gog" ? (
                    <div className="grid gap-2 border border-dashed border-[var(--border)] p-3">
                      <label htmlFor="prime-gog-code" className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--dim2)]">
                        GOG 兑换码 / REDEEM CODE
                      </label>
                      <input
                        id="prime-gog-code"
                        value={gogCode}
                        onChange={(e) => setGogCode(e.target.value)}
                        placeholder="粘贴亚马逊领取页给的兑换码"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-sm tracking-wider text-[var(--text)] outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-[var(--dim2)]"
                      />
                      <button
                        type="button"
                        aria-label={`把兑换码自动兑换进 GOG 账号（《${current.title}》）`}
                        disabled={!gogCode.trim() || redeemMutation.isPending}
                        onClick={() => redeemMutation.mutate(current)}
                        className="cta-hard bg-grad px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
                      >
                        {redeemMutation.isPending ? "兑换中…" : "自动兑换"}
                      </button>
                      {redeemResult?.state === "not-bound" ? (
                        <button type="button" aria-label="去我的页面绑定 GOG 账号" onClick={onGoBind} className="rounded-[14px] border border-[var(--glass-edge-strong)] bg-[var(--surface2)] backdrop-blur-md px-3 py-2 text-[13px] font-bold text-[var(--text)]">
                          去绑定 GOG →
                        </button>
                      ) : null}
                      {redeemResult && !redeemMutation.isPending ? (
                        redeemResult.fallbackUrl ? (
                          <a href={redeemResult.fallbackUrl} target="_blank" rel="noreferrer" aria-label="打开预填了这个兑换码的 GOG 官方兑换页" className="text-center text-xs font-medium leading-relaxed text-[var(--dim)] underline underline-offset-4">
                            自动兑换没成？打开 GOG 官方兑换页（已预填这个码）手动完成 →
                          </a>
                        ) : null
                      ) : (
                        <a href={GOG_REDEEM_URL} target="_blank" rel="noreferrer" aria-label="打开 GOG 官方兑换页" className="text-center text-xs font-medium leading-relaxed text-[var(--dim)] underline underline-offset-4">
                          或去 GOG 官方兑换页手动兑换 →
                        </a>
                      )}
                    </div>
                  ) : null}
                </div>
                {feedback ? <p className="mt-3 text-xs leading-[1.7] text-[var(--dim)]">{feedback}</p> : null}
              </div>
            </div>
            <p className="mt-3 text-center text-xs leading-relaxed text-[var(--dim2)]">
              {current.channel === "epic"
                ? "在亚马逊页点 Claim 后，回来点「检测入库」核对到账。"
                : current.channel === "gog"
                  ? "在亚马逊页拿到兑换码后，粘贴到上面点「自动兑换」。"
                  : "在亚马逊页点 Claim 完成领取后，回到这里点「已领，下一款」。"}
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}


// ---------- bottom tab bar ----------

const TAB_DEFS: { key: MainTab; label: string; icon: ReactNode }[] = [
  {
    key: "today",
    label: "今日",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1.5" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
    ),
  },
  {
    key: "apps",
    label: "APP",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><circle cx="12" cy="9.8" r="2.6" /><path d="M10.5 18.5h3" /></svg>
    ),
  },
  {
    key: "games",
    label: "游戏",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.6 8h10.8a4.4 4.4 0 0 1 4.3 5.3l-.8 3.8A2.2 2.2 0 0 1 16.7 19c-.9 0-1.7-.6-2-1.4L13.7 15h-3.4l-1 2.6c-.3.8-1.1 1.4-2 1.4a2.2 2.2 0 0 1-4.2-1.9l-.8-3.8A4.4 4.4 0 0 1 6.6 8z" /><path d="M8.2 11.6v2.8M6.8 13h2.8" /><circle cx="16" cy="12.4" r=".9" fill="currentColor" stroke="none" /><circle cx="18" cy="14.6" r=".9" fill="currentColor" stroke="none" /></svg>
    ),
  },
  {
    key: "cloud",
    label: "云服务",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.8 18.5h10.6a3.8 3.8 0 0 0 .4-7.6A6 6 0 0 0 6.3 10a4.3 4.3 0 0 0 .5 8.5z" /><path d="M12 9.4v5.8M9.8 13.1 12 15.3l2.2-2.2" /></svg>
    ),
  },
  {
    key: "mine",
    label: "我的",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>
    ),
  },
];

// ---------- batch claim queue (games page 一键入库) ----------
// The selected free games must REALLY land in the user's bound platform
// accounts — the space cannot claim on the user's behalf (Epic's store
// purchase endpoint sits behind a browser session + Cloudflare check; the
// bound tokens only read libraries). So 一键入库 is a guided queue, the
// same shape as the Prime queue: for each game in selection order, open
// its official claim page (the deal's own official link; a labelled store
// search only when the deal carries no link), the user claims there while
// signed into the platform, taps 「已领，下一款」, and at the end
// verifyBatchClaim re-syncs the bound libraries and reconciles every
// game against the real synced rows. Nothing here writes claimed marks:
// a game shows in the library only when a real sync finds it there.

type ClaimTarget = { key: "epic" | "steam" | "gog" | null; label: string };

function claimTargetOf(deal: Deal): ClaimTarget {
  if (deal.gamePlatform === "prime") {
    switch (deal.primeChannel) {
      case "epic":
        return { key: "epic", label: "Epic" };
      case "gog":
        return { key: "gog", label: "GOG" };
      case "amazon":
        return { key: null, label: "Amazon Games App" };
      case "legacy":
        return { key: null, label: "Legacy Games" };
      default:
        return { key: null, label: "Prime 领取页" };
    }
  }
  if (deal.gamePlatform === "epic") return { key: "epic", label: "Epic" };
  if (deal.gamePlatform === "steam") return { key: "steam", label: "Steam" };
  if (deal.gamePlatform === "gog") return { key: "gog", label: "GOG" };
  return { key: null, label: "来源平台" };
}

function claimLinkOf(deal: Deal): { url: string; label: string } | null {
  if (deal.claimUrl) {
    // Epic rows' claimUrl IS the official purchase deep link (assembled
    // server-side from the real namespace/offerId): in a desktop browser
    // it lands straight on the checkout page. Mobile rows combine
    // android+iOS in one link — on a phone browser Epic funnels that
    // link to its app-download page instead (see EPIC_MOBILE_HOP_NOTE).
    // GamerPower mobile duplicates the sync mirrored the official offers
    // onto carry the same purchase link as claimUrl — recognise them by
    // the link itself plus all-mobile offers, not by bucket.
    const purchaseMain = deal.combinedPurchaseUrl != null && deal.claimUrl === deal.combinedPurchaseUrl;
    const mobileOffers = deal.epicOffers.length > 0 && deal.epicOffers.every((o) => o.platform === "android" || o.platform === "ios");
    if (purchaseMain && (deal.gamePlatform === "epic" || mobileOffers)) {
      return { url: deal.claimUrl, label: (deal.epicMobile || mobileOffers) && deal.epicOffers.length > 1 ? "打开 Epic 下单页（一次领两端）" : "打开 Epic 下单页领取" };
    }
    return { url: deal.claimUrl, label: "打开官方领取页" };
  }
  const t = claimTargetOf(deal);
  const name = deal.title.replace(/[《》]/g, "").trim();
  if (t.key === "epic") return { url: `https://store.epicgames.com/browse?q=${encodeURIComponent(name)}`, label: "在 Epic 商店搜索此游戏" };
  if (t.key === "steam") return { url: `https://store.steampowered.com/search/?term=${encodeURIComponent(name)}`, label: "在 Steam 商店搜索此游戏" };
  if (t.key === "gog") return { url: `https://www.gog.com/games?query=${encodeURIComponent(name)}`, label: "在 GOG 商店搜索此游戏" };
  return null;
}

function BatchClaimFlow({
  session,
  items,
  onClose,
  onGoLogin,
  onGoBind,
  onShowLibrary,
}: {
  session: Session | null;
  items: Deal[];
  onClose: () => void;
  onGoLogin: () => void;
  onGoBind: () => void;
  onShowLibrary: () => void;
}) {
  const queryClient = useQueryClient();
  const authToken = session?.token;
  const accountsQuery = useQuery({
    queryKey: ["accounts", session?.username ?? ""],
    queryFn: () => api.getAccounts({ authToken }),
    enabled: !!session,
  });
  const [index, setIndex] = useState(0);
  const [guided, setGuided] = useState<number[]>([]);
  const [phase, setPhase] = useState<"queue" | "verifying" | "results">("queue");
  const [verifyData, setVerifyData] = useState<BatchVerifyData | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const verifyMutation = useMutation({
    mutationFn: (guidedIds: number[]) =>
      api.verifyBatchClaim({
        authToken,
        items: items.map((d) => ({ dealId: d.id, guided: guidedIds.includes(d.id) })),
      }),
    onSuccess: (r) => {
      setVerifyData(r);
      setPhase("results");
      queryClient.invalidateQueries({ queryKey: ["library"] });
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e) => {
      setFeedback(`验库失败：${e instanceof Error ? e.message : String(e)} — 可以再点一次「结束并验库」重试`);
      setPhase("queue");
    },
  });

  const total = items.length;
  const current = index < total ? items[index] : null;
  const boundOf = (key: "epic" | "steam" | "gog") => accountsQuery.data?.platforms.find((p) => p.platform === key);
  const advance = (wasGuided: boolean) => {
    const nextGuided = wasGuided && current ? [...guided, current.id] : guided;
    if (wasGuided) setGuided(nextGuided);
    setFeedback(null);
    if (index + 1 >= total) {
      setPhase("verifying");
      verifyMutation.mutate(nextGuided);
    } else {
      setIndex(index + 1);
    }
  };
  const finishNow = () => {
    setPhase("verifying");
    verifyMutation.mutate(guided);
  };

  const target = current ? claimTargetOf(current) : null;
  const link = current ? claimLinkOf(current) : null;
  // Mobile-ness follows the offers too (same rule as the detail page):
  // a mirrored GamerPower mobile duplicate is not epicMobile-flagged but
  // its claim link is the same combined mobile purchase link, so it gets
  // the same explainer + app-download hop note.
  const currentMobile =
    current != null &&
    (current.epicMobile ||
      (current.combinedPurchaseUrl != null &&
        current.claimUrl === current.combinedPurchaseUrl &&
        current.epicOffers.length > 0 &&
        current.epicOffers.every((o) => o.platform === "android" || o.platform === "ios")));
  const boundStatus = target?.key ? boundOf(target.key) : undefined;
  const results = verifyData?.results ?? [];
  const verified = results.filter((r) => r.status === "verified");
  const notVerified = results.filter((r) => r.status === "not_found" || r.status === "unverifiable");
  const unprocessed = results.filter((r) => r.status === "unprocessed");
  const resultGroup = (title: string, rows: BatchVerifyResult[], emptyText: string) => (
    <section className="mt-4">
      <h3 className="font-serif text-[15px] font-bold text-[var(--text)]">
        {title} <span className="font-mono text-xs font-medium text-[var(--dim2)]">{rows.length} 款</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-xs text-[var(--dim2)]">{emptyText}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-[9px]">
          {rows.map((r) => (
            <li key={r.dealId} className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--glass-hi)] backdrop-blur-md">
              <p className="text-[13px] font-bold leading-[1.35] text-[var(--text)]">{r.title}</p>
              <p className="mt-1 text-xs leading-[1.6] text-[var(--dim)]">{r.note}</p>
              {r.linkUrl ? (
                <a
                  href={r.linkUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`查看 Epic 账户交易页核对 ${r.title}`}
                  className="mt-1.5 inline-block text-xs font-bold text-[var(--accent)]"
                >
                  去 Epic 账户交易页核对 →
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="v-scroll-only fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="一键入库：官方领取队列">
      <div className="mx-auto w-full max-w-3xl px-[22px] pb-[92px]">
        <div className="flex items-center gap-3 pb-2 pt-5">
          <button
            type="button"
            aria-label="关闭一键入库队列"
            onClick={onClose}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-base text-[var(--text)]"
          >
            ←
          </button>
          <h2 className="font-serif text-xl font-black text-[var(--text)]">一键入库</h2>
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-[var(--dim2)]">CLAIM QUEUE</span>
          {phase === "queue" && total > 0 ? (
            <button type="button" aria-label="结束队列并验库" onClick={finishNow} className="ml-auto flex-none text-[13px] font-bold text-[var(--accent)]">
              结束并验库
            </button>
          ) : null}
        </div>

        {!session ? (
          <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] p-5 text-center shadow-[var(--glass-hi)] backdrop-blur-md">
            <p className="font-serif text-[16px] font-bold text-[var(--text)]">先登录站内账号</p>
            <p className="mx-auto mt-2 max-w-[42ch] text-[13px] leading-[1.8] text-[var(--dim)]">验库要同步你在这个账号下绑定的 Epic / Steam / GOG 游戏库，登录后才能对账。</p>
            <button type="button" aria-label="去登录站内账号" onClick={onGoLogin} className="cta-hard mt-4 bg-grad px-5 py-2.5 text-sm font-bold text-[var(--accent-ink)]">
              去登录
            </button>
          </section>
        ) : phase === "verifying" ? (
          <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] p-5 text-center shadow-[var(--glass-hi)] backdrop-blur-md" aria-live="polite">
            <p className="font-serif text-[16px] font-bold text-[var(--text)]">正在同步官方游戏库验库…</p>
            <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-[1.8] text-[var(--dim)]">逐款和你绑定的 Epic / Steam / GOG 账号的真实游戏库对账，游戏多时要等一会儿。</p>
          </section>
        ) : phase === "results" ? (
          <div>
            {verifyData?.needLogin ? (
              <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] p-5 text-center shadow-[var(--glass-hi)] backdrop-blur-md">
                <p className="font-serif text-[16px] font-bold text-[var(--text)]">登录已过期</p>
                <p className="mx-auto mt-2 max-w-[42ch] text-[13px] leading-[1.8] text-[var(--dim)]">重新登录后回到游戏页，再走一次队列验库。</p>
                <button type="button" aria-label="重新去登录" onClick={onGoLogin} className="cta-hard mt-4 bg-grad px-5 py-2.5 text-sm font-bold text-[var(--accent-ink)]">
                  去登录
                </button>
              </section>
            ) : (
              <>
                <section className="mt-4 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] p-4 shadow-[var(--glass-hi)] backdrop-blur-md">
                  <p className="text-[13px] leading-[1.8] text-[var(--dim)]">
                    验库结果：<b className="text-[var(--free-ink)]">{verified.length} 款已在官方库查到</b>
                    {notVerified.length > 0 ? `，${notVerified.length} 款已引导领取但没验证到` : ""}
                    {unprocessed.length > 0 ? `，${unprocessed.length} 款未处理` : ""}。只有同步对账查到的才算真入库，空间没有替你标记任何一款。
                  </p>
                  {verifyData && verifyData.syncNotes.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {verifyData.syncNotes.map((s) => (
                        <li key={s.platform} className="font-mono text-[10.5px] leading-relaxed text-[var(--dim2)]">
                          同步 · {PLATFORM_NAMES[s.platform]}：{s.note}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
                {resultGroup("已验证真入库", verified, "这一轮没有在官方库里查到的游戏。")}
                {resultGroup("已引导领取但未验证到", notVerified, "没有这一类。")}
                {resultGroup("未处理", unprocessed, "没有跳过的游戏。")}
                <div className="mt-6 flex gap-2.5">
                  <button type="button" aria-label="查看我的游戏库" onClick={onShowLibrary} className="cta-hard flex-1 bg-grad px-4 py-3 text-sm font-bold text-[var(--accent-ink)]">
                    看游戏库
                  </button>
                  <button type="button" aria-label="完成并关闭队列" onClick={onClose} className="flex-1 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm font-bold text-[var(--text)] backdrop-blur-md">
                    完成
                  </button>
                </div>
              </>
            )}
          </div>
        ) : current && target ? (
          <div>
            <p className="mt-2 text-[13px] leading-[1.8] text-[var(--dim)]">
              逐款打开对应平台的官方页领取 — 领取动作在官方页面完成，空间负责排队；全部处理完会同步你绑定的游戏库逐款验库，查到了才算真入库。
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--seg-track)]" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={total} aria-label="领取进度">
              <div className="h-full rounded-full bg-grad transition-all" style={{ width: `${(index / Math.max(total, 1)) * 100}%` }} />
            </div>
            <p className="mt-2 font-mono text-[11px] text-[var(--dim2)]" aria-live="polite">
              第 {index + 1} / {total} 款 · 已领 {guided.length} 款
            </p>

            <article className="mt-3 overflow-hidden rounded-[20px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--shadow)] backdrop-blur-md">
              {current.imageUrl ? (
                <div className="relative aspect-[16/9] w-full overflow-hidden bg-[var(--surface2)]">
                  <SafeImg src={current.imageUrl} alt={dealTitle(current)} label={dealTitle(current)} phFontSize={48} className="absolute inset-0 h-full w-full object-cover" />
                </div>
              ) : null}
              <div className="p-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--dim2)]">
                  领取平台 · {target.label}
                  {current.gamePlatform === "prime" ? "（Prime 会员游戏渠道）" : ""}
                </p>
                <h3 className="mt-1.5 font-serif text-[19px] font-bold leading-[1.4] text-[var(--text)]">{dealTitle(current)}</h3>
                <p className="mt-1 text-xs leading-[1.6] text-[var(--dim)]">
                  {current.status === "upcoming" ? "这款还没到领取时间，先跳过，等开领后再来。" : "在官方页登录你的账号领取，领完回来点「已领，下一款」。"}
                </p>
                {currentMobile ? (
                  <div className="mt-2 rounded-[12px] border border-[var(--border)] bg-[var(--surface2)] p-3">
                    <p className="text-xs leading-[1.7] text-[var(--dim)]">
                      这是手游版（{current.mobilePlatforms.map((p) => (p === "android" ? "安卓" : "iOS")).join(" + ")}），和 PC 版是两个独立商品。下单链接一次带上两端 offer；验库只认库里带手游标记的记录，没查到时会让你以 Epic 账户交易页为准。
                    </p>
                    <p className="mt-1.5 text-xs font-medium leading-[1.7] text-[var(--warn)]">{EPIC_MOBILE_HOP_NOTE}</p>
                  </div>
                ) : null}
                {current.regionLocked ? (
                  <p className="mt-2 rounded-[12px] border border-[var(--warn)] bg-[var(--warn-bg)] p-3 text-xs leading-[1.7] text-[var(--text)]">
                    本周锁区：国区 Epic 账号领不到这款，需要外区账号领取。
                  </p>
                ) : null}

                {target.key && accountsQuery.data && !boundStatus?.bound ? (
                  <div className="mt-3 rounded-[12px] border border-[var(--warn)] bg-[var(--warn-bg)] p-3">
                    <p className="text-xs leading-[1.7] text-[var(--text)]">
                      还没绑定 {target.label} 账号：在官方页照样能领，但空间没法同步验库确认到账。先绑定，领完就能自动对账。
                    </p>
                    <button type="button" aria-label={`去绑定 ${target.label} 账号`} onClick={onGoBind} className="mt-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-xs font-bold text-[var(--text)]">
                      去绑定 {target.label}
                    </button>
                  </div>
                ) : null}
                {target.key === "steam" && boundStatus?.bound && !boundStatus.hasApiKey ? (
                  <p className="mt-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface2)] p-3 text-xs leading-[1.7] text-[var(--dim)]">
                    Steam 已绑定但还没填 API Key：领取不受影响，但最后同步验库需要 Key — 在「我的」的 Steam 卡里补填后，回来重新验库即可。
                  </p>
                ) : null}

                <div className="mt-4 grid gap-2.5">
                  {link ? (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${link.label}：${dealTitle(current)}`}
                      className="cta-hard flex items-center justify-center gap-3 rounded-[14px] bg-grad px-4 py-[13px] text-center text-[15px] font-bold tracking-[0.04em] text-[var(--accent-ink)]"
                    >
                      {link.label} <span aria-hidden="true" className="font-mono text-base">→</span>
                    </a>
                  ) : (
                    <span className="rounded-[14px] bg-[var(--surface2)] px-4 py-3.5 text-center text-[13px] font-medium leading-[1.6] text-[var(--dim)]">
                      该条目暂无官方领取链接，请在{target.label}按游戏名搜索领取
                    </span>
                  )}
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      aria-label={`已领取 ${dealTitle(current)}，下一款`}
                      onClick={() => advance(true)}
                      className="h-11 flex-1 rounded-[14px] border border-transparent bg-[var(--free-bg)] text-sm font-bold text-[var(--free-ink)] backdrop-blur-md"
                    >
                      {index + 1 >= total ? "已领，完成并验库" : "已领，下一款"}
                    </button>
                    <button
                      type="button"
                      aria-label={`跳过 ${dealTitle(current)}`}
                      onClick={() => advance(false)}
                      className="h-11 flex-1 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] text-sm font-medium text-[var(--text)] backdrop-blur-md"
                    >
                      跳过这款
                    </button>
                  </div>
                </div>
              </div>
            </article>
            {feedback ? (
              <p className="mt-3 text-center text-xs leading-[1.7] text-[var(--warn)]" role="alert">
                {feedback}
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyNote title="队列是空的" sub="回到游戏页长按多选几款，再点一键入库。" />
        )}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab }: { tab: MainTab; setTab: (t: MainTab) => void }) {
  return (
    <nav
      aria-label="底部导航"
      className="tabbar fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--chrome-bg)] backdrop-blur-[18px]"
    >
      {/* The bar itself absorbs the bottom safe-area inset as padding, so
          wherever the viewport extends through the home-indicator area the
          bar's glass background covers it with the labels lifted clear; in
          shells whose viewport already ends at the safe-area line the inset
          resolves to 0 and the bar sits flush on the viewport's bottom edge.
          (An earlier version hung a separate strip below the bar; in this
          shell that strip is outside the viewport and never paints.) */}
      <div className="mx-auto flex w-full max-w-3xl px-0.5 pb-[max(6px,env(safe-area-inset-bottom,0px))] pt-2">
        {TAB_DEFS.map((d) => {
          const active = tab === d.key;
          return (
            <button
              key={d.key}
              type="button"
              aria-label={`${d.label}页`}
              aria-current={active ? "page" : undefined}
              aria-pressed={active}
              onClick={() => setTab(d.key)}
              className={`relative flex min-w-0 flex-1 flex-col items-center gap-1 whitespace-nowrap text-[9.5px] leading-none transition-colors ${active ? "font-bold text-[var(--accent)]" : "font-medium text-[var(--dim2)]"}`}
            >
              {active ? <span aria-hidden="true" className="absolute -top-2 h-[2.5px] w-[22px] rounded-full bg-grad shadow-[0_0_10px_var(--accent-glow)]" /> : null}
              <span className={`transition-transform ${active ? "-translate-y-0.5" : ""}`}>{d.icon}</span>
              {d.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ---------- app root ----------

export function App() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());
  // Steam OpenID return: when Steam redirects back to this page's own
  // address, the assertion sits in the query string. Detect it before
  // anything renders so this load becomes the dedicated return view
  // (it submits the assertion once and strips the params).
  const [steamReturn] = useState<SteamReturn | null>(() => {
    try {
      return steamReturnFromSearch(window.location.search);
    } catch {
      return null;
    }
  });
  // UI theme: localStorage restores instantly (the index.html pre-paint
  // script already applied it before first paint); while signed in, the
  // account's server-side choice wins on login/session restore.
  const [theme, setThemeState] = useState<UiTheme>(() => loadTheme());
  const themeSyncedForRef = useRef<string | null>(null);
  const setTheme = (t: UiTheme, opts?: { fromServer?: boolean; token?: string }) => {
    setThemeState(t);
    applyThemeAttr(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // storage unavailable — theme simply won't persist locally
    }
    const token = opts?.token ?? session?.token;
    if (!opts?.fromServer && token) {
      api.setUiTheme({ authToken: token, theme: t }).catch(() => {
        // best-effort mirror; the local choice already applied
      });
    }
  };
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");
  const syncThemeFromAccount = (token: string, username: string) => {
    if (themeSyncedForRef.current === username) return;
    themeSyncedForRef.current = username;
    api
      .getSessionUser({ authToken: token })
      .then((r) => {
        if (r.theme) setTheme(r.theme, { fromServer: true });
      })
      .catch(() => {
        // keep the local theme
      });
  };
  const [primeFlowOpen, setPrimeFlowOpen] = useState(false);
  // 一键入库领取队列的条目（游戏页多选的结果，或详情页的单款），按选中顺序。
  const [batchItems, setBatchItems] = useState<Deal[] | null>(null);
  const [tab, setTab] = useState<MainTab>("today");
  const [innerTab, setInnerTab] = useState<InnerTab>("today");
  const [now, setNow] = useState(() => Date.now());
  const [onlySaved, setOnlySaved] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [hideClaimed, setHideClaimed] = useState<boolean>(() => {
    try { return localStorage.getItem("baipiao-hide-claimed") === "1"; } catch { return false; }
  });
  const [hideHidden, setHideHidden] = useState<boolean>(() => {
    try { const v = localStorage.getItem("baipiao-hide-hidden"); return v == null ? true : v === "1"; } catch { return true; }
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const stored = loadSession();
    if (!stored) return;
    let cancelled = false;
    api
      .getSessionUser({ authToken: stored.token })
      .then((r) => {
        if (cancelled) return;
        if (!r.username) {
          storeSession(null);
          setSession(null);
        } else {
          if (r.username !== stored.username) {
            const next = { token: stored.token, username: r.username };
            storeSession(next);
            setSession(next);
          }
          // The account's remembered theme (if any) restores on open.
          if (r.theme) {
            themeSyncedForRef.current = r.username;
            setTheme(r.theme, { fromServer: true });
          }
        }
      })
      .catch(() => {
        // offline or server hiccup: keep the persisted session and let the
        // scoped queries surface any real problem
      });
    return () => {
      cancelled = true;
    };
    // runs once on mount to restore the login state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSessionChange = (next: Session | null) => {
    storeSession(next);
    setSession(next);
    if (next) syncThemeFromAccount(next.token, next.username);
    queryClient.invalidateQueries({ queryKey: ["deals"] });
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
    queryClient.invalidateQueries({ queryKey: ["library"] });
    queryClient.invalidateQueries({ queryKey: ["primeQueue"] });
  };
  useEffect(() => {
    try { localStorage.setItem("baipiao-hide-claimed", hideClaimed ? "1" : "0"); } catch { /* ignore */ }
  }, [hideClaimed]);
  useEffect(() => {
    try { localStorage.setItem("baipiao-hide-hidden", hideHidden ? "1" : "0"); } catch { /* ignore */ }
  }, [hideHidden]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  // The page's real scroll container is the SDK's fixed
  // [data-generated-space-root] layer, not window/body. Some webviews still
  // let it drift sideways (elastic pan) despite the CSS lock, so pin its
  // horizontal offset back to 0 on every scroll frame. Inner horizontal
  // scrollers (chips, screenshot strips) are separate elements and are not
  // touched by this.
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("[data-generated-space-root]");
    if (!scroller) return;
    let raf = 0;
    const clamp = () => {
      if (scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(clamp);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    clamp();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const dealsQuery = useQuery({ queryKey: ["deals"], queryFn: () => api.listDeals({ authToken: session?.token }) });
  const deals = useMemo(() => dealsQuery.data?.deals ?? [], [dealsQuery.data]);
  const detailDeal = useMemo(
    () => (detailId == null ? null : (deals.find((d) => d.id === detailId) ?? null)),
    [deals, detailId],
  );
  const openDetail = (d: Deal) => setDetailId(d.id);

  if (steamReturn) {
    return (
      <div className="min-h-screen max-w-full overflow-x-clip bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <SteamReturnView ret={steamReturn} authToken={session?.token} />
      </div>
    );
  }

  return (
    <div className="min-h-screen max-w-full overflow-x-clip bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-[22px] pb-[92px]">
        {dealsQuery.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : dealsQuery.error ? (
          <div className="mt-6 rounded-[16px] border border-[var(--glass-edge)] bg-[var(--surface)] shadow-[var(--glass-hi)] backdrop-blur-md p-6 text-center">
            <p className="text-sm font-semibold text-[var(--warn)]">加载失败</p>
            <button type="button" aria-label="重试加载" onClick={() => dealsQuery.refetch()} className="mt-4 bg-grad px-5 py-2.5 text-sm font-bold text-[var(--accent-ink)]">重试</button>
          </div>
        ) : tab === "today" ? (
          <TodayPage
            deals={deals}
            now={now}
            onOpen={openDetail}
            innerTab={innerTab}
            setInnerTab={setInnerTab}
            onlySaved={onlySaved}
            setOnlySaved={setOnlySaved}
            showAdd={showAdd}
            setShowAdd={setShowAdd}
            hideClaimed={hideClaimed}
            setHideClaimed={setHideClaimed}
            hideHidden={hideHidden}
            setHideHidden={setHideHidden}
            authToken={session?.token}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
        ) : tab === "apps" ? (
          <AppsPage deals={deals} now={now} onOpen={openDetail} hideClaimed={hideClaimed} hideHidden={hideHidden} />
        ) : tab === "games" ? (
          <GamesPage
            deals={deals}
            now={now}
            onOpen={openDetail}
            hideClaimed={hideClaimed}
            hideHidden={hideHidden}
            onOpenPrimeClaim={() => setPrimeFlowOpen(true)}
            session={session}
            onNeedLogin={() => setTab("mine")}
            onOpenBatchClaim={(items) => setBatchItems(items)}
          />
        ) : tab === "cloud" ? (
          <CloudPage deals={deals} now={now} onOpen={openDetail} hideClaimed={hideClaimed} hideHidden={hideHidden} />
        ) : (
          <MinePage
            session={session}
            theme={theme}
            onToggleTheme={toggleTheme}
            onSessionChange={handleSessionChange}
            onOpenPrimeClaim={() => setPrimeFlowOpen(true)}
            onShowSaved={() => {
              setOnlySaved(true);
              setInnerTab("all");
              setTab("today");
            }}
          />
        )}
      </main>

      <TabBar tab={tab} setTab={setTab} />

      {detailDeal ? (
        <DealDetail
          deal={detailDeal}
          now={now}
          authToken={session?.token}
          onClose={() => setDetailId(null)}
          onQueueClaim={(d) => {
            setDetailId(null);
            if (!session) {
              // 验库记在站内账号名下：未登录先去登录
              setTab("mine");
              return;
            }
            setBatchItems([d]);
          }}
        />
      ) : null}

      {batchItems ? (
        <BatchClaimFlow
          session={session}
          items={batchItems}
          onClose={() => setBatchItems(null)}
          onGoLogin={() => {
            setBatchItems(null);
            setTab("mine");
          }}
          onGoBind={() => {
            setBatchItems(null);
            setTab("mine");
          }}
          onShowLibrary={() => {
            setBatchItems(null);
            setTab("mine");
          }}
        />
      ) : null}

      {primeFlowOpen ? (
        <PrimeClaimFlow
          session={session}
          now={now}
          onClose={() => setPrimeFlowOpen(false)}
          onGoLogin={() => {
            setPrimeFlowOpen(false);
            setTab("mine");
          }}
          onShowLibrary={() => {
            setPrimeFlowOpen(false);
            setTab("mine");
          }}
          onGoBind={() => {
            setPrimeFlowOpen(false);
            setTab("mine");
          }}
        />
      ) : null}
    </div>
  );
}
