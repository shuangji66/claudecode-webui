import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPreferences,
  clampFont,
  preferenceCacheKeys,
  resolvedTheme,
  setThemePreference,
  themePreference,
  watchSystemTheme,
} from "./theme";

describe("theme", () => {
  it("system 跟随系统，显式主题优先", () => {
    expect(resolvedTheme("system", true)).toBe("dark");
    expect(resolvedTheme("system", false)).toBe("light");
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
  });

  it("字号限制在 12–20", () => {
    expect(clampFont(9)).toBe(12);
    expect(clampFont(21)).toBe(20);
    expect(clampFont(15.4)).toBe(15);
    expect(clampFont(Number.NaN)).toBe(15);
  });
});

describe("主题只缓存在浏览器", () => {
  // jsdom 没有 matchMedia：给个最小桩，顺便能手动触发 change。
  const listeners: (() => void)[] = [];
  beforeEach(() => {
    listeners.length = 0;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preference");
  });

  it("setThemePreference 只写 localStorage 与 DOM", () => {
    setThemePreference("dark");
    expect(localStorage.getItem(preferenceCacheKeys.THEME_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themePreference()).toBe("dark");
  });

  it("非法缓存值回落 system", () => {
    localStorage.setItem(preferenceCacheKeys.THEME_KEY, "neon");
    expect(themePreference()).toBe("system");
  });

  it("applyPreferences 的主题来源是缓存，不是 settings", () => {
    localStorage.setItem(preferenceCacheKeys.THEME_KEY, "light");
    // 后端即便还带着 theme（旧版本），也不能覆盖浏览器里的选择。
    applyPreferences({ locale: "en", font_size: 16, theme: "dark" } as never);
    expect(document.documentElement.dataset.theme).toBe("light");
    // 字号/语言仍然跟服务端走。
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("16px");
  });

  it("watchSystemTheme 只在偏好为 system 时回调", () => {
    const calls: number[] = [];
    const stop = watchSystemTheme(() => calls.push(1));
    localStorage.setItem(preferenceCacheKeys.THEME_KEY, "dark");
    listeners.forEach((fn) => fn());
    expect(calls).toHaveLength(0);

    localStorage.setItem(preferenceCacheKeys.THEME_KEY, "system");
    listeners.forEach((fn) => fn());
    expect(calls).toHaveLength(1);
    stop();
  });
});
