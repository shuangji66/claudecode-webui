import { describe, expect, it } from "vitest";
import { clampFont, resolvedTheme } from "./theme";

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
