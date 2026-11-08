/**
 * FGame — Epic / GOG 网页登录「自动回连」桥。
 *
 * 为什么需要原生层：Epic 的登录页带 X-Frame-Options: SAMEORIGIN +
 * COOP: same-origin，浏览器页面既不能 iframe 嵌入、也无法读取跨域
 * popup 的 URL / 内容，且从不 postMessage 授权码给 opener —— 所以纯
 * Web 版只能让用户复制粘贴。原生 App（小黑盒 / Heroic）用内嵌
 * WKWebView 可以监听导航与页面内容，登录后自动拿到 code。
 *
 * 本模块把这条链路接到 Capacitor iOS 壳：
 *   openPlatformLoginNative()  → fgame://oauth 深链 → AppDelegate 弹原生 WKWebView
 *   (原生 detector 抓到 code) → CustomEvent('fgameOAuthCode') → onPlatformAuthCode()
 *
 * Web 端 openPlatformLoginNative 返回 false，调用方沿用原来的
 * popup + 完成绑定 + 剪贴板逻辑，功能零回归。
 */
import { Capacitor } from "@capacitor/core";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/** 用原生 WKWebView 打开平台官方登录页。仅 iOS 原生壳生效。
 *  返回 true 表示已交给原生层，调用方不要再 window.open。 */
export function openPlatformLoginNative(platform: "epic" | "gog", loginUrl: string): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return false;
  const deep = `fgame://oauth?platform=${encodeURIComponent(platform)}&url=${encodeURIComponent(loginUrl)}`;
  // Capacitor 主 WKWebView 会把自定义 scheme 交给系统，触发
  // AppDelegate.application(_:open:options:)，由后者弹出登录控制器。
  window.location.href = deep;
  return true;
}

export type PlatformAuthCode = { platform: "epic" | "gog"; code: string };

/** 订阅原生层回传的授权码；返回取消订阅函数。 */
export function onPlatformAuthCode(cb: (payload: PlatformAuthCode) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<PlatformAuthCode>).detail;
    if (detail && (detail.platform === "epic" || detail.platform === "gog") && detail.code) {
      cb(detail);
    }
  };
  window.addEventListener("fgameOAuthCode", handler);
  return () => window.removeEventListener("fgameOAuthCode", handler);
}
