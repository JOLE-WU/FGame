/**
 * FGame — Epic 一键领取原生桥。
 *
 * 纯 Web 版做不到真·一键：Epic 的 0 元下单在 store.epicgames.com 的网页会话
 * 里完成，且服务器 IP 被 Cloudflare 挡。原生壳用内嵌 WKWebView 复用已登录
 * cookie，像真人一样点过结算页（见 ios-overrides/AppDelegate.swift）。
 *
 * 本模块把这条链路接到 Capacitor iOS 壳：
 *   openEpicClaimNative(offers) → fgame://claim?payload=<base64> 深链
 *     → AppDelegate 弹领取 WebView → 自动下单
 *     → CustomEvent('fgameClaimResult') → onClaimResult()
 * Web 端 openEpicClaimNative 返回 false，调用方沿用原来的「去领取」手动流程。
 */
import { Capacitor } from "@capacitor/core";

export type ClaimOffer = { namespace: string; offerId: string; title: string };
export type ClaimResult = {
  ok: boolean;
  claimed: string[];
  /** Titles already in the user's Epic library ("already own" / "in library").
   *  These count as 已领取 too — the game IS in the account, just not a new
   *  order. Optional so older native builds (which never sent it) still work. */
  owned?: string[];
  failed: string[];
  total: number;
};

export function isNativeClaimAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/** 用原生内嵌 WebView 打开 Epic 领取流程。返回 true 表示已交给原生层。 */
export function openEpicClaimNative(offers: ClaimOffer[]): boolean {
  if (!isNativeClaimAvailable() || offers.length === 0) return false;
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ offers }))));
  const deep = `fgame://claim?payload=${encodeURIComponent(payload)}`;
  window.location.href = deep;
  return true;
}

/** 订阅原生层回传的领取结果；返回取消订阅函数。 */
export function onClaimResult(cb: (result: ClaimResult) => void): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<ClaimResult>).detail;
    if (d && typeof d === "object" && Array.isArray(d.claimed)) cb(d);
  };
  window.addEventListener("fgameClaimResult", handler);
  return () => window.removeEventListener("fgameClaimResult", handler);
}
