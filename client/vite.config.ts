import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./", // relative assets so the bundle also works from a WKWebView / file://
  plugins: [react(), tailwindcss()],
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
