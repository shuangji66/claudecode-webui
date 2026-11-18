import { beforeEach, describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  hiddenFeaturesSnapshot,
  isFeatureKey,
  loadHiddenFeatures,
  parseHiddenFeatures,
  resetHiddenFeaturesCache,
  saveHiddenFeatures,
  setHiddenFeatures,
  toggleFeature,
  toggleHiddenFeature,
} from "./sidebarFeatures";

const KEY = "ccweb-sidebar-feature-hidden";

describe("侧栏功能区偏好", () => {
  beforeEach(() => {
    localStorage.clear();
    resetHiddenFeaturesCache();
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

  // 侧栏同时存在两个实例（桌面常驻 + 移动端抽屉）：偏好必须共享，
  // 否则一边取消固定、另一边用自己的旧快照整体回写，选择会被抹掉。
  it("共享快照：改动对所有实例可见，且引用稳定", () => {
    toggleHiddenFeature("plugins");
    expect([...hiddenFeaturesSnapshot()]).toEqual(["plugins"]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual(["plugins"]);

    // getSnapshot 必须返回同一个引用：每次返回新 Set 会让 useSyncExternalStore 无限重渲染。
    expect(hiddenFeaturesSnapshot()).toBe(hiddenFeaturesSnapshot());

    setHiddenFeatures([]);
    expect([...hiddenFeaturesSnapshot()]).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual([]);
  });
});
