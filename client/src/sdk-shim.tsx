/**
 * FGame — open replacement for the closed-source `@hatch/space-sdk/client`.
 *
 * The original project was a WorkBuddy "TS Space" whose client runtime was
 * shipped as a private tarball (file:/opt/hatch/...). That tarball does not
 * exist on any public CI runner, so it is replaced here with a small,
 * dependency-free equivalent. Public API kept identical so App.tsx needs no
 * rewrite.
 */
import { QueryClient } from "@tanstack/react-query";
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
  const call = async (action: string, args: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/actions${RPC_QUERY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, args: args ?? {} }),
      });
    } catch (e) {
      throw new ActionError(
        `无法连接 FGame 服务（${API_BASE || "当前站点"}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const raw = await res.text().catch(() => "");
    let body: { ok?: boolean; data?: unknown; error?: string } = {};
    try {
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      throw new ActionError(`服务返回了非 JSON 内容（HTTP ${res.status}）`, res.status);
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

export type ApiRequest<C, K extends keyof C> = C[K] extends (args: infer Q) => Promise<any> ? Q : never;
export type ApiResponse<C, K extends keyof C> = C[K] extends (...a: any[]) => Promise<infer R> ? R : never;

/* ------------------------------------------------------------------ */
/* Safe area scrim                                                     */
/* ------------------------------------------------------------------ */

/** Covers the status-bar / notch area with the app's base colour.
 *  In the original Space this came from the SDK; the CSS equivalent is
 *  enough once the WebView uses viewport-fit=cover (see index.html). */
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
