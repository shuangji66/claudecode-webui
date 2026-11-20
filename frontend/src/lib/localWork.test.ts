import { describe, expect, it } from "vitest";
import { hasLocalWork, localWorkFrom, NO_LOCAL_WORK } from "./localWork";

describe("localWorkFrom", () => {
  it("status=compacting 记成「正在压缩」", () => {
    const w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    expect(w.compacting).toBe(true);
    expect(hasLocalWork(w)).toBe(true);
  });

  it("重复的 compacting 帧不改变状态（对象引用稳定）", () => {
    const first = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    expect(
      localWorkFrom(first, { type: "system", subtype: "status", status: "compacting", compact_output_chars: 0 }),
    ).toBe(first);
  });

  // `compact_output_chars` 在涨就说明摘要真的在写（CLI 的 schema 原话）；
  // 它只让「正在压缩」这句提示带上一个会动的数字，不涨什么都证明不了。
  it("compact_output_chars 跟着压缩状态走", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, {
      type: "system",
      subtype: "status",
      status: "compacting",
      compact_output_chars: 800,
    });
    expect(w.compactChars).toBe(800);
    w = localWorkFrom(w, { type: "system", subtype: "status", status: "compacting", compact_output_chars: 2400 });
    expect(w.compactChars).toBe(2400);
    w = localWorkFrom(w, { type: "system", subtype: "status", status: "requesting", compact_output_chars: 0 });
    expect(w.compactChars).toBe(0);
  });

  it("status=requesting 结束压缩状态（CLI 在等上游了）", () => {
    const compacting = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    const done = localWorkFrom(compacting, { type: "system", subtype: "status", status: "requesting" });
    expect(done.compacting).toBe(false);
  });

  it("status=null 也结束压缩状态（CLI 清理时就这么发）", () => {
    const compacting = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    expect(localWorkFrom(compacting, { type: "system", subtype: "status", status: null }).compacting).toBe(false);
  });

  it("compact_boundary 结束压缩状态", () => {
    const compacting = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    expect(
      localWorkFrom(compacting, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } })
        .compacting,
    ).toBe(false);
  });

  it("真正的上游帧也结束压缩状态（有字节回来就说明不在压缩里）", () => {
    const compacting = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    for (const frame of [
      { type: "stream_event", event: { type: "message_start" } },
      { type: "assistant", message: { content: [] } },
      { type: "result", subtype: "success" },
    ]) {
      expect(localWorkFrom(compacting, frame).compacting).toBe(false);
    }
  });

  it("未被压缩状态时收到上游帧原样返回（不制造新对象）", () => {
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "assistant" })).toBe(NO_LOCAL_WORK);
  });

  it("hook_started / hook_response 成对记账", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, {
      type: "system",
      subtype: "hook_started",
      hook_id: "h1",
      hook_name: "fmt",
      hook_event: "PostToolUse",
    });
    expect(w.hooks).toEqual(["h1"]);
    expect(hasLocalWork(w)).toBe(true);
    w = localWorkFrom(w, { type: "system", subtype: "hook_response", hook_id: "h1", outcome: "success" });
    expect(w.hooks).toEqual([]);
    expect(hasLocalWork(w)).toBe(false);
  });

  it("多个 hook 并行时逐个结束", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_started", hook_id: "a" });
    w = localWorkFrom(w, { type: "system", subtype: "hook_started", hook_id: "b" });
    expect(w.hooks).toEqual(["a", "b"]);
    w = localWorkFrom(w, { type: "system", subtype: "hook_response", hook_id: "a" });
    expect(w.hooks).toEqual(["b"]);
  });

  it("没有 hook_id 的帧不记账（记下来永远清不掉）", () => {
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_started" })).toBe(NO_LOCAL_WORK);
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_response" })).toBe(NO_LOCAL_WORK);
  });

  it("压缩与 hook 互不干扰", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    w = localWorkFrom(w, { type: "system", subtype: "hook_started", hook_id: "h1" });
    expect(w).toMatchObject({ compacting: true, hooks: ["h1"] });
    w = localWorkFrom(w, { type: "system", subtype: "status", status: "requesting" });
    expect(w).toMatchObject({ compacting: false, hooks: ["h1"] });
  });

  it("认不出的帧原样返回", () => {
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "init" })).toBe(NO_LOCAL_WORK);
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "unknown-type" })).toBe(NO_LOCAL_WORK);
    expect(localWorkFrom(NO_LOCAL_WORK, null)).toBe(NO_LOCAL_WORK);
  });
});
