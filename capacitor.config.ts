import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.fgame.daily",
  appName: "FGame",
  webDir: "client/dist",
  bundledWebRuntime: false,
  ios: {
    contentInset: "always",
    scheme: "FGame",
    // The web bundle is shipped inside the app; only data/actions go to the
    // self-hosted FGame API (VITE_API_BASE at build time).
  },
  plugins: {
    // No third-party login SDK: OAuth auto-link is handled natively in
    // AppDelegate.swift (see ios-overrides/) and never sends credentials
    // through this app.
  },
};

export default config;
