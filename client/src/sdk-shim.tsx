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

/** Base URL of the FGame server. Empty = same origin (web dev / Space).
 *  In the iOS app set VITE_API_BASE to the deployed backend, e.g.
 *  https://fgame-api.example.com — see README. */
const RAW_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
export const API_BASE = RAW_BASE.replace(/\/$/, "");

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
      res = await fetch(`${API_BASE}/actions`, {
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
