/**
 * FGame standalone server — replaces the closed WorkBuddy Space runtime.
 * Pure Node (no Bun, no Xcode): better-sqlite3 + node:http.
 *
 *   POST /actions        { action, args }  -> { ok, data } | { ok:false, error }
 *   GET  /blobs/<key>    stored avatar / image bytes
 *   GET  /health         liveness
 *   GET  /*              static web build (when FGAME_WEB_DIR is set)
 *
 * CORS is fully open on purpose: the iOS WKWebView origin
 * (capacitor://localhost) must be able to call the deployed API.
 */
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { Actions } from "./actions";
import { db, runMigrations } from "./db";
import type { Ctx } from "./sdk-shim";

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIR = process.env.FGAME_WEB_DIR ? resolve(process.env.FGAME_WEB_DIR) : null;
const BLOBS_DIR = resolve(process.env.FGAME_BLOBS_DIR ?? "./blobs");
const DRIZZLE_DIR = resolve(process.env.FGAME_DRIZZLE_DIR ?? "./drizzle");
const SELF_ORIGIN = process.env.FGAME_PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
// Published links are protected by a `sharecode` credential. A browser gets
// an HttpOnly cookie from the page, but the iOS WKWebView loads <img> across
// origins without that cookie, so blob/avatar URLs must carry it too.
const BLOB_QUERY = process.env.FGAME_SHARECODE
  ? `?sharecode=${encodeURIComponent(process.env.FGAME_SHARECODE)}`
  : "";

mkdirSync(BLOBS_DIR, { recursive: true });
const applied = runMigrations(DRIZZLE_DIR);
if (applied.length) console.log(`[fgame] applied ${applied.length} migration(s)`);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });

/** Blob paths are confined to BLOBS_DIR (no traversal). */
function blobPath(key: string): string | null {
  const clean = normalize(key).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  if (clean.startsWith("..")) return null;
  const p = isAbsolute(clean) ? null : join(BLOBS_DIR, clean);
  if (!p || !p.startsWith(BLOBS_DIR)) return null;
  return p;
}

const ctx: Ctx = {
  db: () => db,
  blobs: {
    async getUrl(key) {
      const p = blobPath(key);
      return p && existsSync(p) ? `${SELF_ORIGIN}/blobs/${encodeURI(key)}${BLOB_QUERY}` : null;
    },
    async put(key, bytes) {
      const p = blobPath(key);
      if (!p) throw new Error("invalid blob key");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    },
    async delete(key) {
      const p = blobPath(key);
      if (p && existsSync(p)) unlinkSync(p);
    },
  },
  // Best-effort AI translation is unavailable standalone; every caller in
  // actions.ts catches the rejection and keeps the English original.
  inference: {
    async complete() {
      throw new Error("FGAME_LLM_ENDPOINT not configured");
    },
  },
  agent: {
    async spawnTask() {
      return { ok: false };
    },
  },
  invalidateQueries: () => {},
};

type ActionEntry = {
  request?: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { message: string } } };
  handler: (c: Ctx, a: any) => unknown | Promise<unknown>;
};

const registry = Actions as unknown as Record<string, ActionEntry>;

async function handleAction(body: unknown): Promise<Response> {
  if (typeof body !== "object" || body === null) return json({ ok: false, error: "invalid request" }, 400);
  const { action, args } = body as { action?: unknown; args?: unknown };
  if (typeof action !== "string" || !(action in registry)) {
    return json({ ok: false, error: `unknown action: ${String(action)}` }, 400);
  }
  const entry = registry[action]!;
  let parsed: unknown = args ?? {};
  if (entry.request) {
    const r = entry.request.safeParse(parsed);
    if (!r.success) return json({ ok: false, error: `参数错误：${r.error?.message ?? "invalid"}` }, 400);
    parsed = r.data;
  }
  try {
    const data = await entry.handler(ctx, parsed);
    return json({ ok: true, data: data ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[fgame] action ${action} failed:`, message);
    return json({ ok: false, error: message });
  }
}

function fileResponse(p: string): Response {
  const ext = extname(p);
  const buf = readFileSync(p);
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", ...cors },
  });
}

/** Blob keys (avatars/<id>) have no extension, so sniff the magic bytes.
 *  Without a real image/* type the iOS WKWebView may refuse to render <img>. */
function blobMime(buf: Buffer): string {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length > 6 && buf.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return "application/octet-stream";
}

function serveStatic(pathname: string): Response {
  if (!WEB_DIR) return json({ ok: false, error: "web build not served here" }, 404);
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const p = join(WEB_DIR, rel);
  if (!p.startsWith(WEB_DIR) || !existsSync(p)) {
    const index = join(WEB_DIR, "index.html");
    return existsSync(index)
      ? fileResponse(index)
      : json({ ok: false, error: "not found" }, 404);
  }
  return fileResponse(p);
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "POST" && url.pathname === "/actions") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }
    return handleAction(body);
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      app: "FGame",
      actions: Object.keys(registry).length,
      autoRefresh: process.env.FGAME_AUTO_REFRESH === "1",
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/blobs/")) {
    const p = blobPath(decodeURIComponent(url.pathname.slice("/blobs/".length)));
    if (!p || !existsSync(p)) return json({ ok: false, error: "not found" }, 404);
    const buf = readFileSync(p);
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": blobMime(buf), ...cors },
    });
  }
  if (req.method === "GET") return serveStatic(url.pathname);
  return json({ ok: false, error: "method not allowed" }, 405);
}

/* ---- node:http <-> Web Fetch adapter ---- */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  return new Request(`http://localhost:${PORT}${req.url ?? "/"}`, {
    method,
    headers: req.headers as HeadersInit,
    body: hasBody ? new Uint8Array(body) : undefined,
  });
}

async function writeResponse(web: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  web.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(web.status, headers);
  const buf = Buffer.from(await web.arrayBuffer());
  res.end(buf.length ? buf : undefined);
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const web = await route(await toWebRequest(req));
      await writeResponse(web, res);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[fgame] request error", message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
      }
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  })();
});

// Bind 0.0.0.0 explicitly: the published app is reached through a reverse
// proxy that connects over IPv4, and some sandboxes resolve `listen(PORT)`'s
// default IPv6 wildcard in a way the proxy cannot reach.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fgame] FGame API listening on :${PORT} (${Object.keys(registry).length} actions)`);
});

/* Optional daily refresh — the Space host used to run this as a cron job.
   Enable with FGAME_AUTO_REFRESH=1 and FGAME_REFRESH_MS (default 6h). */
if (process.env.FGAME_AUTO_REFRESH === "1") {
  const ms = Number(process.env.FGAME_REFRESH_MS ?? 6 * 60 * 60 * 1000);
  // Hard cap per run. refreshDeals upserts the main GamerPower / Epic feeds
  // early, so a run that reaches the cap has already refreshed everything a
  // user sees; the remaining best-effort enrichment is left to next cycle.
  const capMs = Number(process.env.FGAME_REFRESH_CAP_MS ?? 120_000);
  let running = false;
  const refresh = async () => {
    if (running) return; // never stack refreshes on top of each other
    const entry = registry["refreshDeals"];
    if (!entry) return;
    running = true;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let capped = false;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => entry.handler(ctx, {}))
          .then(() => console.log(`[fgame] refresh done in ${Date.now() - started}ms`))
          .catch((e) => console.error("[fgame] refresh failed", e)),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => { capped = true; resolve(); }, capMs);
        }),
      ]);
      if (capped) console.log("[fgame] refresh hit time cap; main feeds already stored");
    } finally {
      if (timer) clearTimeout(timer);
      running = false;
    }
  };
  setInterval(() => { void refresh(); }, ms);
  // Let the HTTP server settle first; the sync itself is async and never
  // blocks request handling.
  setTimeout(() => { void refresh(); }, 3000);
}
