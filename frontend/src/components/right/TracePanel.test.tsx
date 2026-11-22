import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TracePanel } from "./TracePanel";
import { useAppStore } from "../../store/useAppStore";
import type { Item } from "../../lib/model";

const items: Item[] = [
  { id: "u1", seq: 0, ts: 1_000, kind: "user", text: "看看 git 状态" },
  { id: "a1", seq: 1, ts: 2_000, kind: "assistant", text: "我先看一下", streaming: false, model: "claude-sonnet-4-5" },
  {
    id: "t1",
    seq: 2,
    ts: 2_000,
    kind: "tool",
    toolUseId: "tu1",
    name: "Bash",
    input: { command: "git status" },
    result: "clean",
    doneAt: 5_000,
  },
  {
    id: "t2",
    seq: 3,
    ts: 5_500,
    kind: "tool",
    toolUseId: "tu2",
    name: "Agent",
    input: { description: "查依赖" },
    doneAt: 6_000,
    subagent: {
      taskId: "task-1",
      agentId: "agent-1",
      status: "completed",
      type: "Explore",
      description: "查依赖",
      usage: { totalTokens: 500, toolUses: 2, durationMs: 4_000 },
    },
  },
  { id: "a2", seq: 4, ts: 10_000, kind: "assistant", text: "好了", streaming: false },
  { id: "r1", seq: 5, ts: 10_000, kind: "result", durationMs: 9_000 },
];

function setup() {
  useAppStore.setState({
    activeId: "s1",
    items: { s1: items },
    states: { s1: "ready" },
    subagentView: null,
    scrollRequest: null,
  });
}

beforeEach(() => {
  setup();
});

describe("TracePanel", () => {
  it("画出轮次、泳道与步骤表", () => {
    render(<TracePanel />);
    expect(screen.getByText("共 1 轮")).toBeInTheDocument();
    expect(screen.getByText("第 1 轮 / 1")).toBeInTheDocument();
    expect(screen.getByText("看看 git 状态")).toBeInTheDocument();
    // 工具段与子代理段都在步骤表里各占一行。
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("查依赖")).toBeInTheDocument();
    expect(screen.queryByText("运行命令")).not.toBeInTheDocument();
  });

  it("点某一步请求对话区滚到那一条", () => {
    render(<TracePanel />);
    fireEvent.click(screen.getByText("Bash"));
    expect(useAppStore.getState().scrollRequest?.itemId).toBe("t1");
  });

  // 侧栏可能是盖在对话区上面的抽屉/全屏：只滚不说话的话，用户看到的就是「点了没反应」。
  it("点某一步之后通知调用方收起遮挡层", () => {
    const onJump = vi.fn();
    render(<TracePanel onJump={onJump} />);
    fireEvent.click(screen.getByText("Bash"));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  // 轮次切换、子代理「对话」入口都不离开这一页，别顺手把侧栏关了。
  it("切轮次与打开子代理不触发 onJump", () => {
    const onJump = vi.fn();
    render(<TracePanel onJump={onJump} />);
    fireEvent.click(screen.getByRole("button", { name: "下一轮" }));
    fireEvent.click(screen.getByText("对话"));
    expect(onJump).not.toHaveBeenCalled();
  });

  it("子代理那一行给「对话」入口，点了打开子代理标签", () => {
    render(<TracePanel />);
    fireEvent.click(screen.getByText("对话"));
    expect(useAppStore.getState().subagentView).toMatchObject({ agentId: "agent-1", label: "查依赖" });
  });

  it("没有对话时给一句人话，而不是空白", () => {
    useAppStore.setState({ activeId: null, items: {} });
    render(<TracePanel />);
    expect(screen.getByText(/先打开一条对话/)).toBeInTheDocument();
  });
});
