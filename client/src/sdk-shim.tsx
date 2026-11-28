/**
 * FGame — open replacement for the closed-source `@hatch/space-sdk/client`.
 *
 * The original project was a WorkBuddy "TS Space" whose client runtime was
 * shipped as a private tarball (file:/opt/hatch/...). That tarball does not
 * exist on any public CI runner, so it is replaced here with a small,
 * dependency-free equivalent. Public API kept identical so App.tsx needs no
 * rewrite.
 */
import { QueryClient, dehydrate, hydrate, type DehydratedState } from "@tanstack/react-query";
import { z } from "zod";
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* RPC transport                                                       */
/* ------------------------------------------------------------------ */

/**
 * Deployed FGame API (published WorkBuddy app). The share link carries a
 * `sharecode` access credential: a browser gets an HttpOnly cookie on the
 * first page load, so same-origin web requests need nothing extra. The iOS
 * WKWebView, however, runs on `capacitor://localhost`, is cross-origin and
 * has no cookie — native builds must therefore use this absolute origin
 * AND append the sharecode to every RPC request.
 *
 * These are public by design: this backend exists precisely so that anyone
 * who receives the app can use it. Set VITE_API_BASE at build time to point
 * a native build at a different backend.
 */
const PUBLIC_API_ORIGIN = "https://a81bed224b123cc64.app.workbuddy.host";
const PUBLIC_API_SHARECODE = "73QDIHJLBR";

const isNativeWebView =
  typeof location !== "undefined" && !/^https?:$/.test(location.protocol);

/** Empty = same origin (web / local dev). */
const RAW_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  (isNativeWebView ? PUBLIC_API_ORIGIN : "");
export const API_BASE = RAW_BASE.replace(/\/$/, "");

/**
 * Third-party login (Steam OpenID) needs an https realm / return_to. The iOS
 * WKWebView runs on `capacitor://localhost`, which Steam rejects outright and
 * renders as a blank page, so callbacks must always target the public origin
 * instead of `window.location.origin`.
 */
export function oauthPublicBase(): string {
  if (API_BASE) return API_BASE;
  return typeof location !== "undefined" ? location.origin : PUBLIC_API_ORIGIN;
}

/** The published app's access credential, needed on the callback URL because
 *  the reverse proxy rejects requests without it (no cookie on that hop). */
export function oauthSharecode(): string {
  if (typeof location !== "undefined") {
    const fromUrl = new URLSearchParams(location.search).get("sharecode");
    if (fromUrl) return fromUrl;
  }
  return PUBLIC_API_SHARECODE;
}

/** Credential suffix for clients that have no access cookie. */
const RPC_QUERY =
  isNativeWebView && API_BASE === PUBLIC_API_ORIGIN
    ? `?sharecode=${encodeURIComponent(PUBLIC_API_SHARECODE)}`
    : "";

export class ActionError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ActionError";
    this.status = status;
  }
}

type AnyFn = (...args: any[]) => Promise<any>;

/** The shape `defineAction` produces on the server (see server/sdk-shim). */
export type ActionDef<Q = any, R = any> = {
  description: string;
  request: z.ZodType<Q>;
  response: z.ZodType<R>;
  // `handler`'s ctx is intentionally `any`: the server's Ctx is not available
  // in the browser bundle, and keeping it loose avoids contravariance
  // breaking the Q/R inference below.
  handler: (...a: any[]) => any;
};

/** Maps an Actions module to its typed RPC client:
 *  `{ foo: ActionDef<Req, Res> }` -> `{ foo: (args: Req) => Promise<Res> }`. */
export type ClientOf<M> = {
  [K in keyof M]: M[K] extends ActionDef<infer Q, infer R> ? (args: Q) => Promise<R> : AnyFn;
};

export function createActionClient<M>(): ClientOf<M> {
  // WKWebView can sit on a request indefinitely when the proxy in front of the
  // backend is down (it answers 504 only after 30s, and the native fetch may
  // not surface that at all) — which the user sees as "加载中" forever. Fail
  // fast instead, so the UI can show its retry card.
  const TIMEOUT_MS = 20_000;
  // Server-side jobs that legitimately run for tens of seconds (library
  // sync, code redemption, catalogue refresh). A 20s cap would have reported
  // a successful GOG redeem — it syncs the whole library before answering —
  // as a timeout, so these get room.
  const SLOW_ACTIONS = new Set([
    "redeemPrimeGogCode",
    "syncPlatformLibrary",
    "syncAllPlatformLibraries",
    "refreshDeals",
    "refreshIosFreeApps",
    "refreshAppPrices",
    "backfillBrandLogos",
    "backfillIosFreeAndLogos",
    "backfillEpicAcquiredAt",
    "refreshPlaytimes",
    // End-of-queue 验库 re-syncs every involved bound library before it
    // can answer. A single Epic sync alone takes ~30s (770+ titles), and a
    // queue spanning Epic+Steam+GOG can take a minute — a 20s cap made a
    // perfectly successful verify look like a network timeout.
    "verifyBatchClaim",
    // Each unresolved title costs one Steam store-page fetch (the appreviews
    // JSON endpoint is unreachable from the backend host). A 40-title batch
    // runs 8 at a time and can legitimately take well over 20s.
    "libraryRatings",
  ]);
  const SLOW_TIMEOUT_MS = 120_000;
  // The published backend is a mainland-China endpoint (Tencent Cloud CLB).
  // A device-wide proxy/VPN routes it through an overseas exit, where it is
  // unreachable — the user sees a bare "加载失败" with no idea why. Surface
  // the actionable fix in the error itself (now shown on the retry card).
  const NETWORK_HINT =
    "如果设备开启了网络代理 / VPN，请把 *.workbuddy.host 加入直连（DIRECT）规则，或暂时关闭代理后重试；本服务部署在国内，走境外代理常会超时或被拦截。";
  const call = async (action: string, args: unknown): Promise<unknown> => {
    const limit = SLOW_ACTIONS.has(action) ? SLOW_TIMEOUT_MS : TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/actions${RPC_QUERY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, args: args ?? {} }),
        signal:
          typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
            ? AbortSignal.timeout(limit)
            : undefined,
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ActionError(
          `连接 FGame 服务超时（${Math.round(limit / 1000)} 秒无响应）。${NETWORK_HINT}`,
        );
      }
      throw new ActionError(
        `无法连接 FGame 服务（${API_BASE || "当前站点"}）：${e instanceof Error ? e.message : String(e)}。${NETWORK_HINT}`,
      );
    }
    const raw = await res.text().catch(() => "");
    let body: { ok?: boolean; data?: unknown; error?: string } = {};
    try {
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      throw new ActionError(
        `服务返回了非 JSON 内容（HTTP ${res.status}），多是代理/VPN 返回了拦截页。${NETWORK_HINT}`,
        res.status,
      );
    }
    if (!res.ok || body.ok === false) {
      throw new ActionError(body.error || `请求失败（HTTP ${res.status}）`, res.status);
    }
    return body.data;
  };

  return new Proxy({} as ClientOf<M>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (args: unknown) => call(prop, args);
    },
  });
}

/** Shared QueryClient (the Space SDK exposed one singleton). */
export const spaceQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

/* ------------------------------------------------------------------ */
/* Offline / cold-start cache (stale-while-revalidate)                  */
/* ------------------------------------------------------------------ */
// The whole UI used to hang on ONE 650 KB `listDeals` request: react-query's
// cache lives in memory only, so killing the app (routine on iOS) threw it
// away and every cold start paid the full download + 4 s of loading again.
// Persist the handful of expensive/shared queries to localStorage. On the
// next launch hydrate them BEFORE React renders, so the first paint shows
// last session's data instantly; react-query still refetches anything past
// its staleTime in the background. Only successful queries are stored, and
// volatile per-item lookups (detail/reviews/translate) are excluded to keep
// the blob small.
const CACHE_KEY = "fgame-query-cache-v1";
const CACHE_MAX_AGE = 7 * 24 * 60 * 60_000;
const CACHE_PREFIXES = ["deals", "appPrices", "fxRates", "appleArcadeGames", "appWatches", "freeHistory"];

(function restoreQueryCache() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { ts: number; token: string; state: DehydratedState };
    // `deals` keys carry per-user saved/claimed marks but their queryKey has
    // no token — never let one account's snapshot flash for another. The
    // token is a fingerprint; an empty token means the signed-out pool.
    const tokenNow = localStorage.getItem("baipiao-session-token") ?? "";
    if (!parsed?.state || typeof parsed.ts !== "number" || Date.now() - parsed.ts > CACHE_MAX_AGE || parsed.token !== tokenNow) {
      localStorage.removeItem(CACHE_KEY);
      return;
    }
    hydrate(spaceQueryClient, parsed.state);
  } catch {
    // Corrupt/oversized blob or storage disabled — ignore, network still works.
    try { localStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
  }
})();

(function persistQueryCache() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    try {
      if (typeof localStorage === "undefined") return;
      const state = dehydrate(spaceQueryClient, {
        shouldDehydrateQuery: (q) =>
          q.state.status === "success" &&
          CACHE_PREFIXES.some((p) => (q.queryKey[0] as string)?.startsWith?.(p) ?? false),
      });
      if (!state.queries.length) return;
      const token = localStorage.getItem("baipiao-session-token") ?? "";
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), token, state }));
    } catch {
      // Quota exceeded (WebView caps localStorage) — drop the blob so a later
      // flush can retry with a fresh size; the app keeps working regardless.
      try { localStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
    }
  };
  spaceQueryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1200);
  });
})();

/** Drop the persisted cache (e.g. on account switch, to avoid showing another
 *  user's saved/claimed marks for a frame). The in-memory queries are cleared
 *  too so the next mount refetches under the new identity. */
export function clearPersistedQueryCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
  spaceQueryClient.clear();
}

export type ApiRequest<C, K extends keyof C> = C[K] extends (args: infer Q) => Promise<any> ? Q : never;
export type ApiResponse<C, K extends keyof C> = C[K] extends (...a: any[]) => Promise<infer R> ? R : never;

/* ------------------------------------------------------------------ */
/* Safe area scrim                                                     */
/* ------------------------------------------------------------------ */

/** Covers the status-bar / notch area with the app's base colour.
 *  In the original Space this came from the SDK; the CSS equivalent is
 *  enough once the WebView uses viewport-fit=cover (see index.html). */
/** Covers the home-indicator strip with the bottom bar's colour.
 *  iOS insets the WebView by the safe area, so the last few points at the
 *  bottom belong to the native window: when the page rubber-bands at the
 *  end of a scroll they show through as a black band (the window's default
 *  colour). This strip keeps that area painted with the bar colour, and the
 *  native side paints the same colour behind the WebView as a second layer. */
export function SafeAreaBottomScrim({ backgroundColor }: { backgroundColor?: string }) {
  return (
    <div
      aria-hidden="true"
      data-safe-bottom
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: "env(safe-area-inset-bottom, 0px)",
        background: backgroundColor ?? "var(--chrome-bg-strong)",
        zIndex: 31,
        pointerEvents: "none",
      }}
    />
  );
}

export function SafeAreaTopScrim({ backgroundColor }: { backgroundColor?: string; children?: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "env(safe-area-inset-top, 0px)",
        background: backgroundColor ?? "var(--bg)",
        zIndex: 60,
        pointerEvents: "none",
      }}
    />
  );
}
