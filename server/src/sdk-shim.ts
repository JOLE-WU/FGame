/**
 * FGame — open replacement for the closed-source `@hatch/space-sdk` server
 * runtime. `actions.ts` imports `defineAction`, `z`, `Ctx` and
 * `ActionsModule` from here instead of the private tarball.
 */
import { z } from "zod";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema";

export { z };

export type DB = BetterSQLite3Database<typeof schema>;

export type BlobStore = {
  /** Returns a publicly reachable URL for a stored blob, or null. */
  getUrl(key: string): Promise<string | null>;
  /** Stores bytes under a key (overwrites). */
  put(key: string, bytes: Uint8Array, opts?: { contentType?: string }): Promise<void>;
  delete?(key: string): Promise<void>;
};

export type Ctx = {
  /** `ctx.db<typeof schema>()` — the generic is retained for source compat. */
  db: <_T = typeof schema>() => DB;
  blobs: BlobStore;
  /** Best-effort LLM translation. Failures are caught by every caller. */
  inference: {
    complete(prompt: string, opts?: { schema?: unknown }): Promise<any>;
  };
  /** Background task spawner. Only used as a best-effort fallback. */
  agent: {
    spawnTask(
      prompt: string,
      opts?: { expectsAction?: string; dedupeKey?: string },
    ): Promise<{ ok: boolean }>;
  };
  /** Cache invalidation hint from the Space host — a no-op standalone. */
  invalidateQueries: () => void;
};

export type ActionDef<Q = any, R = any> = {
  description: string;
  request: z.ZodType<Q>;
  response: z.ZodType<R>;
  handler: (ctx: Ctx, args: Q) => R | Promise<R>;
};

export type ActionsModule = Record<string, ActionDef<any, any>>;

/** Identity function: registers the action descriptor with its inferred
 *  request/response types so the client can derive them at compile time. */
export function defineAction<Q, R>(def: ActionDef<Q, R>): ActionDef<Q, R> {
  return def;
}
