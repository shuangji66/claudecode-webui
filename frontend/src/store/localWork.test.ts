import { beforeEach, describe, expect, it } from "vitest";
import { __resetSyncState, localWork, useAppStore } from "./useAppStore";
import { hasLocalWork } from "../lib/localWork";

/**
 * 「CLI 在自己干活、没在等上游」的状态（压缩中 / hook 在跑）是**过程态**：
 * 压缩那条 `status: compacting` 只发一次、hook 的起止也只有一次，都不进转录。
 * 所以它既要跟着实时帧更新，也要随 `session.snapshot` 对齐——压缩途中刷新页面
 * 拿不到那条帧，没有快照就只能误报「上游 N 秒没有响应」。
 */
describe("本地在干活的状态", () => {
  beforeEach(() => {
    __resetSyncState();
    useAppStore.setState({ activeId: "s1", states: {}, inits: {}, perms: {}, conns: {} });
  });

  const cli = (data: unknown) => ({ kind: "cli", data });

  it("压缩帧把它置上，收尾帧摘掉", () => {
    useAppStore.getState().applyEvent("s1", cli({ type: "system", subtype: "status", status: "compacting" }) as never);
    expect(hasLocalWork(localWork("s1"))).toBe(true);
    useAppStore.getState().applyEvent("s1", cli({ type: "system", subtype: "status", status: null }) as never);
    expect(hasLocalWork(localWork("s1"))).toBe(false);
  });

  it("hook 跑起来时记名字（不是那次运行的 id）", () => {
    useAppStore.getState().applyEvent(
      "s1",
      cli({ type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "PostToolUse:Read" }) as never,
    );
    expect(localWork("s1").hooks).toEqual([{ id: "h1", name: "PostToolUse:Read" }]);
  });

  it("快照里的 busy 覆盖本地那份（压缩途中刷新页面靠它）", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "session.snapshot",
      data: {
        info: { state: "busy" },
        busy: { compacting: true, hooks: [{ id: "h1", name: "SessionStart" }] },
      },
    });
    const work = localWork("s1");
    expect(work.compacting).toBe(true);
    expect(work.hooks).toEqual([{ id: "h1", name: "SessionStart" }]);
  });

  // 与后台任务表同一条规矩：快照是**这一刻**的权威答案，缺字段代表「确实没有」。
  // 留着旧值的话，压缩途中被杀掉再重连，界面会永远停在「正在压缩上下文」。
  it("快照里没有 busy 时按「没在干活」处理", () => {
    useAppStore.getState().applyEvent("s1", cli({ type: "system", subtype: "status", status: "compacting" }) as never);
    expect(localWork("s1").compacting).toBe(true);
    useAppStore.getState().applyEvent("s1", { kind: "session.snapshot", data: { info: { state: "ready" } } });
    expect(localWork("s1").compacting).toBe(false);
  });

  it("进程结束时一起清掉（否则重连之后一直以为还在压缩）", () => {
    useAppStore.getState().applyEvent("s1", cli({ type: "system", subtype: "status", status: "compacting" }) as never);
    useAppStore.getState().applyEvent("s1", { kind: "closed", data: {} } as never);
    expect(localWork("s1").compacting).toBe(false);
  });

  it("别的会话的状态不互相污染", () => {
    useAppStore.getState().applyEvent("s1", cli({ type: "system", subtype: "status", status: "compacting" }) as never);
    expect(hasLocalWork(localWork("s2"))).toBe(false);
  });

  // 子代理的正文也是 `assistant` 帧，而 `localWorkFrom` 把 assistant 当成
  // 「上游出声了，压缩早已结束」。子代理跑着的时候主会话可能仍在压缩——按它的帧
  // 清掉，计时行就会在压缩途中退回「上游 Ns 没有响应」。
  it("子代理的帧不改写主会话的压缩状态", () => {
    useAppStore.getState().applyEvent("s1", cli({ type: "system", subtype: "status", status: "compacting" }) as never);
    useAppStore.getState().applyEvent("s1", cli({
      type: "assistant",
      parent_tool_use_id: "tu1",
      agent_id: "ag1",
      message: { content: [{ type: "text", text: "子代理说的话" }] },
    }) as never);
    expect(localWork("s1").compacting).toBe(true);
  });
});
