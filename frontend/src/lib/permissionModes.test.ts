import { describe, expect, it } from "vitest";
import { isDangerousPermissionMode, permissionModeWarning } from "./permissionModes";

describe("permissionModes", () => {
  it("只把不询问与跳过权限当成危险模式", () => {
    expect(isDangerousPermissionMode("dontAsk")).toBe(true);
    expect(isDangerousPermissionMode("bypassPermissions")).toBe(true);
    for (const mode of ["", "default", "acceptEdits", "plan", "unknown"]) {
      expect(isDangerousPermissionMode(mode)).toBe(false);
    }
    expect(isDangerousPermissionMode(undefined)).toBe(false);
  });

  it("两个危险模式都有中英文的一句话说明", () => {
    for (const mode of ["dontAsk", "bypassPermissions"]) {
      const zh = permissionModeWarning(mode, "zh");
      const en = permissionModeWarning(mode, "en");
      expect(zh.title).not.toBe("");
      expect(zh.message.length).toBeGreaterThan(10);
      expect(en.title).not.toBe("");
      expect(en.message.length).toBeGreaterThan(10);
      expect(zh.message).not.toBe(en.message);
    }
  });

  it("安全模式不需要警告文案", () => {
    expect(permissionModeWarning("default", "zh")).toEqual({ title: "", message: "" });
  });
});
