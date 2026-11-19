import { beforeEach, describe, expect, it } from "vitest";
import { ASK_DRAFT_MAX_AGE_MS, MAX_ASK_DRAFTS, clearAskProgress, loadAskProgress, saveAskProgress } from "./askDrafts";

describe("模型提问的作答草稿", () => {
  beforeEach(() => localStorage.clear());

  it("按 request_id 存取，切题与自定义文本都跟着回来", () => {
    saveAskProgress("req-1", 1, [
      { selected: ["A"], custom: "", refused: false },
      { selected: [], custom: "自己写的", refused: false },
    ]);
    expect(loadAskProgress("req-1", 2)).toEqual({
      index: 1,
      drafts: [
        { selected: ["A"], custom: "", refused: false },
        { selected: [], custom: "自己写的", refused: false },
      ],
    });
  });

  it("题目数量对不上就丢弃（半份草稿套到另一批题上会给出错误的默认选中）", () => {
    saveAskProgress("req-2", 0, [{ selected: ["A"], custom: "", refused: false }]);
    expect(loadAskProgress("req-2", 2)).toBeNull();
  });

  it("下标越界时夹回范围内", () => {
    saveAskProgress("req-3", 5, [{ selected: ["A"], custom: "", refused: false }, { selected: [], custom: "", refused: false }, { selected: [], custom: "", refused: false }]);
    expect(loadAskProgress("req-3", 3)?.index).toBe(2);
  });

  it("「已跳过这题」的标记跟着草稿一起存取", () => {
    saveAskProgress("req-skip", 0, [
      { selected: [], custom: "", refused: true },
      { selected: ["A"], custom: "", refused: false },
    ]);
    expect(loadAskProgress("req-skip", 2)?.drafts).toEqual([
      { selected: [], custom: "", refused: true },
      { selected: ["A"], custom: "", refused: false },
    ]);
  });

  it("旧版本写的草稿没有 refused 字段：按「没跳过」读，不能凭空变成已跳过", () => {
    localStorage.setItem(
      "ccweb-ask-drafts",
      JSON.stringify({ legacy: { index: 0, drafts: [{ selected: ["A"], custom: "" }], at: Date.now() } }),
    );
    expect(loadAskProgress("legacy", 1)?.drafts[0]).toEqual({ selected: ["A"], custom: "", refused: false });
  });

  // 卡片一挂载就会调 saveAskProgress：空进度落盘会挤掉真正有用的草稿。
  it("没有任何作答且停在第 1 题时不落盘", () => {
    saveAskProgress("req-empty", 0, [{ selected: [], custom: "  ", refused: false }]);
    expect(loadAskProgress("req-empty", 1)).toBeNull();
    expect(localStorage.getItem("ccweb-ask-drafts")).toBeNull();
  });

  it("作答被清空后删掉旧草稿，而不是留一条空记录", () => {
    saveAskProgress("req-clear", 0, [{ selected: ["A"], custom: "", refused: false }]);
    expect(loadAskProgress("req-clear", 1)).not.toBeNull();
    saveAskProgress("req-clear", 0, [{ selected: [], custom: "", refused: false }]);
    expect(loadAskProgress("req-clear", 1)).toBeNull();
  });

  it("清掉之后不再返回", () => {
    saveAskProgress("req-4", 0, [{ selected: [], custom: "x", refused: false }]);
    clearAskProgress("req-4");
    expect(loadAskProgress("req-4", 1)).toBeNull();
  });

  it("只保留最近的若干条，过期的直接忽略", () => {
    for (let i = 0; i < MAX_ASK_DRAFTS + 3; i += 1) {
      saveAskProgress(`r${i}`, 0, [{ selected: ["A"], custom: "", refused: false }]);
    }
    expect(loadAskProgress("r0", 1)).toBeNull();
    expect(loadAskProgress(`r${MAX_ASK_DRAFTS + 2}`, 1)).not.toBeNull();

    const stale = { "old": { index: 0, drafts: [{ selected: [], custom: "", refused: false }], at: Date.now() - ASK_DRAFT_MAX_AGE_MS - 1 } };
    localStorage.setItem("ccweb-ask-drafts", JSON.stringify(stale));
    expect(loadAskProgress("old", 1)).toBeNull();
  });

  it("坏 JSON 当没有草稿，不抛错", () => {
    localStorage.setItem("ccweb-ask-drafts", "{ not json");
    expect(loadAskProgress("req-5", 1)).toBeNull();
  });
});
