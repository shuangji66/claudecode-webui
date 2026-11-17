import { describe, expect, it } from "vitest";
import { MAX_QUEUED, enqueuePrompt, headPrompt, removePrompt, shouldFlushAfter, updatePrompt, type QueuedPrompt } from "./queue";

function fill(n: number): QueuedPrompt[] {
  let q: QueuedPrompt[] = [];
  for (let i = 0; i < n; i += 1) q = enqueuePrompt(q, `第 ${i} 条`, [], "File: ", 1000 + i) ?? q;
  return q;
}

describe("待发送队列", () => {
  it("按顺序入队，队首就是最早那条", () => {
    const q = fill(3);
    expect(q.map((x) => x.text)).toEqual(["第 0 条", "第 1 条", "第 2 条"]);
    expect(headPrompt(q)?.text).toBe("第 0 条");
    expect(q[0].label).toBe("File: ");
  });

  it("空消息不入队（回车按住空格不该占一格）", () => {
    expect(enqueuePrompt([], "   ")).toBeNull();
    // 只有附件也算一条消息。
    expect(enqueuePrompt([], "", [{ name: "a.png", media_type: "image/png", data: "aGk=" }])).toHaveLength(1);
  });

  it("满了返回 null，调用方据此提示而不是静默丢弃", () => {
    const q = fill(MAX_QUEUED);
    expect(enqueuePrompt(q, "多余的")).toBeNull();
  });

  it("改一条：正文与附件都生效，位置不变（排队顺序就是上下文顺序）", () => {
    const q = fill(3);
    const att = { name: "a.png", media_type: "image/png", data: "aGk=" };
    const next = updatePrompt(q, q[1].id, "  改过的第二条  ", [att]);
    expect(next.map((x) => x.text)).toEqual(["第 0 条", "改过的第二条", "第 2 条"]);
    expect(next[1].attachments).toEqual([att]);
    expect(next[1].id).toBe(q[1].id);
  });

  it("改一条时不给附件就保留原附件", () => {
    const att = { name: "a.txt", media_type: "text/plain", data: "aGk=" };
    const base = enqueuePrompt([], "带附件", [att]) as QueuedPrompt[];
    const next = updatePrompt(base, base[0].id, "只改正文");
    expect(next[0].attachments).toEqual([att]);
  });

  it("正文与附件都被清空 = 删掉这条", () => {
    const base = enqueuePrompt([], "会被清空") as QueuedPrompt[];
    expect(updatePrompt(base, base[0].id, "   ")).toHaveLength(0);
  });

  it("按 id 删除，其余顺序不变", () => {
    const q = fill(3);
    const left = removePrompt(q, q[1].id);
    expect(left.map((x) => x.text)).toEqual(["第 0 条", "第 2 条"]);
  });
});

describe("回合结束后要不要自动发下一条", () => {
  it("正常结束才发", () => {
    expect(shouldFlushAfter({ type: "result", subtype: "success", is_error: false })).toBe(true);
    expect(shouldFlushAfter({ type: "result", subtype: "error_max_turns" })).toBe(true);
  });

  it("被中断不发：用户按 Esc 是停手，替他接着发等于替他决定继续", () => {
    expect(shouldFlushAfter({ type: "result", subtype: "interrupted" })).toBe(false);
    expect(shouldFlushAfter({ type: "result", subtype: "user_interrupt" })).toBe(false);
  });

  it("出错不发：再灌消息只会把错误叠起来", () => {
    expect(shouldFlushAfter({ type: "result", subtype: "success", is_error: true })).toBe(false);
  });

  it("非 result（流式增量、assistant、tool_progress）不触发", () => {
    expect(shouldFlushAfter({ type: "assistant" })).toBe(false);
    expect(shouldFlushAfter({ type: "stream_event" })).toBe(false);
    expect(shouldFlushAfter(null)).toBe(false);
  });
});
