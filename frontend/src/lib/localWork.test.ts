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

  // CLI 的压缩心跳是 `{type:"sdk_status", status:"compacting"}`，每 30 秒一次、
  // **不带 `compact_output_chars`**（二进制的 sZ → Gus）。当成 0 的话界面上
  // 「已写 12K 字」会每 30 秒跳回 0，看着像进度倒退。
  it("心跳不带 compact_output_chars 时保留上一次的数，不跳回 0", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, {
      type: "system",
      subtype: "status",
      status: "compacting",
      compact_output_chars: 5000,
    });
    expect(w.compactChars).toBe(5000);
    w = localWorkFrom(w, { type: "system", subtype: "status", status: "compacting" });
    expect(w.compactChars).toBe(5000);
    // 明确给 0 才归零（新一轮摘要在写）。
    w = localWorkFrom(w, { type: "system", subtype: "status", status: "compacting", compact_output_chars: 0 });
    expect(w.compactChars).toBe(0);
  });

  it("从没给过 chars 时是 0，不是 undefined", () => {
    const w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
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
    // 显示的用 name（实测 CLI 给的是 `PostToolUse:Read` 这种），id 只用来配对结束。
    expect(w.hooks).toEqual([{ id: "h1", name: "fmt" }]);
    expect(hasLocalWork(w)).toBe(true);
    w = localWorkFrom(w, { type: "system", subtype: "hook_response", hook_id: "h1", outcome: "success" });
    expect(w.hooks).toEqual([]);
    expect(hasLocalWork(w)).toBe(false);
  });

  it("hook 没有 hook_name 时退回 id（至少能指出是哪一个）", () => {
    const w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_started", hook_id: "h1" });
    expect(w.hooks).toEqual([{ id: "h1", name: "h1" }]);
  });

  it("多个 hook 并行时逐个结束", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_started", hook_id: "a", hook_name: "A" });
    w = localWorkFrom(w, { type: "system", subtype: "hook_started", hook_id: "b", hook_name: "B" });
    expect(w.hooks.map((h) => h.id)).toEqual(["a", "b"]);
    w = localWorkFrom(w, { type: "system", subtype: "hook_response", hook_id: "a" });
    expect(w.hooks.map((h) => h.id)).toEqual(["b"]);
  });

  it("没有 hook_id 的帧不记账（记下来永远清不掉）", () => {
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_started" })).toBe(NO_LOCAL_WORK);
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "hook_response" })).toBe(NO_LOCAL_WORK);
  });

  it("压缩与 hook 互不干扰", () => {
    let w = localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "status", status: "compacting" });
    w = localWorkFrom(w, { type: "system", subtype: "hook_started", hook_id: "h1" });
    expect(w).toMatchObject({ compacting: true, hooks: [{ id: "h1", name: "h1" }] });
    w = localWorkFrom(w, { type: "system", subtype: "status", status: "requesting" });
    expect(w).toMatchObject({ compacting: false, hooks: [{ id: "h1", name: "h1" }] });
  });

  it("认不出的帧原样返回", () => {
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "system", subtype: "init" })).toBe(NO_LOCAL_WORK);
    expect(localWorkFrom(NO_LOCAL_WORK, { type: "unknown-type" })).toBe(NO_LOCAL_WORK);
    expect(localWorkFrom(NO_LOCAL_WORK, null)).toBe(NO_LOCAL_WORK);
  });
});
