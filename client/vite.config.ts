import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * One version number for the whole app. CI (build-ipa.yml) passes
 * FGAME_VERSION / FGAME_BUILD for every .ipa; local builds fall back to
 * package.json so the "我的" page never shows a blank version.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };
const APP_VERSION = process.env.FGAME_VERSION || pkg.version;
const APP_BUILD = process.env.FGAME_BUILD || "";

export default defineConfig({
  root,
  base: "./", // relative assets so the bundle also works from a WKWebView / file://
  plugins: [react(), tailwindcss()],
  define: {
    __FGAME_VERSION__: JSON.stringify(APP_VERSION),
    __FGAME_BUILD__: JSON.stringify(APP_BUILD),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    // Dev only: forward RPC calls to the local FGame server.
    proxy: process.env.VITE_DEV_API
      ? { "/actions": { target: process.env.VITE_DEV_API, changeOrigin: true } }
      : undefined,
  },
});
