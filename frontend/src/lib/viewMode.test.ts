import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROCESS_VIEW,
  parseProcessView,
  processView,
  resetProcessViewCache,
  setProcessView,
  subscribeProcessView,
} from "./viewMode";

describe("parseProcessView", () => {
  it("认三档，其余一律回落到默认", () => {
    expect(parseProcessView("concise")).toBe("concise");
    expect(parseProcessView("standard")).toBe("standard");
    expect(parseProcessView("detailed")).toBe("detailed");
    expect(parseProcessView("")).toBe(DEFAULT_PROCESS_VIEW);
    expect(parseProcessView(null)).toBe(DEFAULT_PROCESS_VIEW);
    expect(parseProcessView("huge")).toBe(DEFAULT_PROCESS_VIEW);
  });
});

describe("过程展示偏好", () => {
  beforeEach(() => {
    localStorage.clear();
    resetProcessViewCache();
  });

  it("默认标准（对齐 DSH 的桌面默认值）", () => {
    expect(DEFAULT_PROCESS_VIEW).toBe("standard");
    expect(processView()).toBe("standard");
  });

  it("旧版本写下的 compact/grouped 按「标准」读，且不改写磁盘上的值", () => {
    expect(parseProcessView("compact")).toBe("standard");
    expect(parseProcessView("grouped")).toBe("standard");
    localStorage.setItem("ccweb-process-view", "grouped");
    resetProcessViewCache();
    expect(processView()).toBe("standard");
    expect(localStorage.getItem("ccweb-process-view")).toBe("grouped");
  });

  it("写入后落库，重新读缓存也是新值", () => {
    setProcessView("detailed");
    expect(localStorage.getItem("ccweb-process-view")).toBe("detailed");
    resetProcessViewCache();
    expect(processView()).toBe("detailed");
  });

  it("变更通知订阅者，取消订阅后不再通知", () => {
    const fn = vi.fn();
    const off = subscribeProcessView(fn);
    setProcessView("concise");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setProcessView("standard");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
