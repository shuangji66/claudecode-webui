// 界面偏好落到 DOM：主题、字号、语言。
//
// **主题只存在浏览器**（localStorage 的 ccweb-theme-pref）：每台设备各看各的，
// 不进 settings.json；字号与语言仍然跟着服务端设置走。
// 解析后的 light/dark 写到 <html data-theme>，CSS 令牌与 Tailwind dark: 都跟它走；
// index.html 的启动脚本读同一份缓存，在样式加载前先定主题，避免闪白。

import type { PublicSettings } from "../transport/types";

const THEME_KEY = "ccweb-theme-pref";
const FONT_KEY = "ccweb-font-size";
const LOCALE_KEY = "ccweb-locale";

function cacheGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function cacheSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式忽略
  }
}

export function resolvedTheme(preference: string, prefersDark: boolean): "light" | "dark" {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark ? "dark" : "light";
}

/** 当前主题偏好：只读浏览器缓存，后端没有这一项。 */
export function themePreference(): "system" | "light" | "dark" {
  const value = cacheGet(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

/** 应用一个主题偏好（写 DOM + 缓存）。设置页切主题走这里，不经过后端。 */
export function setThemePreference(preference: "system" | "light" | "dark"): void {
  applyTheme(preference);
}

function applyTheme(preference: string): void {
  if (typeof document === "undefined") return;
  const prefersDark = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(preference, prefersDark);
  root.dataset.themePreference = preference;
  cacheSet(THEME_KEY, preference);
}

/** 把设置应用到 DOM；settings 为空时沿用缓存/默认值。主题只认浏览器缓存。 */
export function applyPreferences(settings: PublicSettings | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const font = clampFont(settings?.font_size ?? (Number(cacheGet(FONT_KEY)) || 15));
  const locale = settings?.locale || cacheGet(LOCALE_KEY) || "zh";

  applyTheme(themePreference());
  root.lang = locale;
  root.style.setProperty("--chat-font-size", `${font}px`);
  root.style.setProperty("--code-font-size", `${Math.max(10, font - 2.5)}px`);

  cacheSet(FONT_KEY, String(font));
  cacheSet(LOCALE_KEY, locale);
}

export function clampFont(px: number): number {
  if (!Number.isFinite(px)) return 15;
  return Math.min(20, Math.max(12, Math.round(px)));
}

/** 订阅系统外观变化；仅在主题偏好为 system 时需要重新解析。 */
export function watchSystemTheme(apply: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (themePreference() === "system") apply();
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

export const preferenceCacheKeys = { THEME_KEY, FONT_KEY, LOCALE_KEY };
