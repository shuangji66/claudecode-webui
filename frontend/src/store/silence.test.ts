import { beforeEach, describe, expect, it } from "vitest";
import { __resetSyncState, lastSound, noteFrame, notePrompt, useAppStore } from "./useAppStore";

/**
 * 「上游多久没出声」的水位（见 lib/silence 与 TurnTimer）。
 *
 * CLI 在一个字节都不回的那段时间里什么都不发：`api_retry` 只在失败之后才有，
 * `keep_alive` 又被后端单独丢掉了（AGENTS 4.2.3）。前端只能靠「最后一条帧什么时候到的」
 * 自己判断沉默，所以要确认每一类帧都真的会刷新这个水位。
 */
describe("上游沉默水位", () => {
  beforeEach(() => {
    __resetSyncState();
    useAppStore.setState({ activeId: "s1", items: {}, states: {}, conns: {}, inits: {}, perms: {} });
  });

  it("还没收到过任何帧 / 没记过时间时是 undefined", () => {
    expect(lastSound("s1")).toBeUndefined();
    expect(lastSound(null)).toBeUndefined();
  });

  // 正文、思考、工具、结果都走同一条 cli 帧：任何一种到达都说明链路是活的。
  it("收到 cli 帧就刷新水位", () => {
    noteFrame("s1");
    const at = lastSound("s1");
    expect(at).toBeTypeOf("number");
  });

  it("applyEvent 处理真实帧时会刷新水位（不是只在发 prompt 时记一次）", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "system", subtype: "init", session_id: "s1" },
    } as never);
    expect(lastSound("s1")).toBeTypeOf("number");
  });

  it("发出 prompt 时也从此刻开始算（不沿用上一轮的旧时间）", () => {
    noteFrame("s1");
    const before = lastSound("s1")!;
    notePrompt("s1");
    expect(lastSound("s1")).toBeGreaterThanOrEqual(before);
  });

  // 删除对话后不清的话，这张表会随对话数量无限长。
  it("清掉会话后水位一起消失", () => {
    noteFrame("s1");
    expect(lastSound("s1")).toBeTypeOf("number");
    __resetSyncState();
    expect(lastSound("s1")).toBeUndefined();
  });
});
