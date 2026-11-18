import { beforeEach, describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  isFeatureKey,
  loadHiddenFeatures,
  parseHiddenFeatures,
  saveHiddenFeatures,
  toggleFeature,
} from "./sidebarFeatures";

const KEY = "ccweb-sidebar-feature-hidden";

describe("侧栏功能区偏好", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("默认全部固定（隐藏名单为空）", () => {
    expect([...loadHiddenFeatures()]).toEqual([]);
  });

  it("不认识的 id 一律忽略，坏 JSON 当作空名单", () => {
    expect(parseHiddenFeatures(["plugins", "nope", 3, null])).toEqual(["plugins"]);
    expect(parseHiddenFeatures({ plugins: true })).toEqual([]);
    localStorage.setItem(KEY, "{oops");
    expect([...loadHiddenFeatures()]).toEqual([]);
  });

  it("取消固定 / 重新固定都会落盘，且按固定顺序写出", () => {
    let hidden = toggleFeature([], "history");
    hidden = toggleFeature(hidden, "plugins");
    saveHiddenFeatures(hidden);

    // 写的是隐藏名单，顺序跟 FEATURE_KEYS 走，不跟点击顺序走。
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["plugins", "history"]);
    expect([...loadHiddenFeatures()]).toEqual(["plugins", "history"]);
  });

  it("切换两次回到原状", () => {
    const hidden = toggleFeature(toggleFeature([], "mcp"), "mcp");
    expect([...hidden]).toEqual([]);
  });

  it("isFeatureKey 只认清单里的入口", () => {
    for (const key of FEATURE_KEYS) expect(isFeatureKey(key)).toBe(true);
    expect(isFeatureKey("general")).toBe(false);
  });
});
