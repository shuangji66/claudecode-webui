import { describe, expect, it } from "vitest";
import { AVAILABLE_PAGE_SIZE, availableQuery, EMPTY_PLUGINS, normalizePlugins, splitPluginID } from "./plugins";

describe("normalizePlugins", () => {
  it("空响应回落成安全空值", () => {
    expect(normalizePlugins(null)).toBe(EMPTY_PLUGINS);
    expect(normalizePlugins(undefined).installed).toEqual([]);
  });

  it("数组字段为 null 时兜成空数组（否则 .map 白屏）", () => {
    const out = normalizePlugins({ supported: true } as never);
    expect(out.installed).toEqual([]);
    expect(out.marketplaces).toEqual([]);
    expect(out.available_total).toBe(0);
    expect(out.job).toBeNull();
  });

  it("supported 只认 true", () => {
    expect(normalizePlugins({ supported: "yes" } as never).supported).toBe(false);
  });
});

describe("splitPluginID", () => {
  it("拆出名字与市场", () => {
    expect(splitPluginID("hello@market")).toEqual({ name: "hello", marketplace: "market" });
    expect(splitPluginID("hello")).toEqual({ name: "hello", marketplace: "" });
    expect(splitPluginID("@market")).toEqual({ name: "@market", marketplace: "" });
  });
});

describe("availableQuery", () => {
  it("默认带分页参数", () => {
    expect(availableQuery({})).toBe(`offset=0&limit=${AVAILABLE_PAGE_SIZE}`);
  });

  it("带上搜索、市场与「只看未安装」", () => {
    const qs = availableQuery({ q: " git commit ", market: "m", hideInstalled: true, offset: 40 });
    expect(qs).toContain("q=git+commit");
    expect(qs).toContain("market=m");
    expect(qs).toContain("hide_installed=1");
    expect(qs).toContain("offset=40");
  });

  it("负数 offset 夹到 0，空搜索词不写进查询串", () => {
    const qs = availableQuery({ q: "   ", offset: -5 });
    expect(qs).not.toContain("q=");
    expect(qs).toContain("offset=0");
  });
});
