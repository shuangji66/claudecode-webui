import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSE_TIMINGS,
  DEFAULT_COLLAPSE_TIMING,
  DEFAULT_FOLDED_REPLIES,
  FOLDED_REPLIES,
  foldedReplies,
  parseFoldedReplies,
  resetFoldedRepliesCache,
  setFoldedReplies,
  DEFAULT_PROCESS_VIEW,
  collapseTiming,
  parseCollapseTiming,
  resetCollapseTimingCache,
  setCollapseTiming,
  subscribeCollapseTiming,
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

describe("收起时机", () => {
  it("两档：完成时收起（默认）/ 下次发送时收起", () => {
    expect(COLLAPSE_TIMINGS).toEqual(["onComplete", "onNextSend"]);
    expect(DEFAULT_COLLAPSE_TIMING).toBe("onComplete");
    expect(parseCollapseTiming("onNextSend")).toBe("onNextSend");
    expect(parseCollapseTiming("whatever")).toBe("onComplete");
  });

  it("与展示档位各存各的，互不影响", () => {
    localStorage.clear();
    resetProcessViewCache();
    resetCollapseTimingCache();
    setProcessView("concise");
    setCollapseTiming("onNextSend");
    expect(localStorage.getItem("ccweb-process-view")).toBe("concise");
    expect(localStorage.getItem("ccweb-collapse-timing")).toBe("onNextSend");
    resetCollapseTimingCache();
    expect(collapseTiming()).toBe("onNextSend");
  });

  it("变更通知订阅者", () => {
    const fn = vi.fn();
    const off = subscribeCollapseTiming(fn);
    setCollapseTiming("onNextSend");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("收起后的回复", () => {
  it("两档：全部回复（默认）/ 仅最终回答", () => {
    expect(FOLDED_REPLIES).toEqual(["all", "final"]);
    expect(DEFAULT_FOLDED_REPLIES).toBe("all");
    expect(parseFoldedReplies("final")).toBe("final");
    expect(parseFoldedReplies("nope")).toBe("all");
  });

  it("独立存储，不影响另外两条轴", () => {
    localStorage.clear();
    resetFoldedRepliesCache();
    setFoldedReplies("final");
    expect(localStorage.getItem("ccweb-folded-replies")).toBe("final");
    resetFoldedRepliesCache();
    expect(foldedReplies()).toBe("final");
  });
});
