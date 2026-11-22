import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentCard } from "./AgentCard";
import type { ToolItem } from "../../lib/model";
import { useAppStore } from "../../store/useAppStore";

function agentTool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "toolu_01",
    name: "Agent",
    input: { description: "probe child", prompt: "say hi", subagent_type: "general-purpose" },
    subagent: {
      taskId: "task-1",
      agentId: "abc123",
      type: "general-purpose",
      description: "probe child",
      status: "running",
      usage: { totalTokens: 1900, toolUses: 3, durationMs: 2500 },
    },
    ...over,
  };
}

describe("AgentCard", () => {
  beforeEach(() => {
    useAppStore.setState({ subagentView: null });
  });

  it("显示描述、类型、状态与用量", () => {
    render(<AgentCard item={agentTool()} />);
    expect(screen.getByText("probe child")).toBeInTheDocument();
    expect(screen.getByText("general-purpose")).toBeInTheDocument();
    expect(screen.getByText("运行中…")).toBeInTheDocument();
    expect(screen.getByText("1.9K tokens")).toBeInTheDocument();
    expect(screen.getByText("3 次工具")).toBeInTheDocument();
    // 子代理耗时同样走分:秒（2.5s → 00:03，四舍五入）。
    expect(screen.getByText("00:03")).toBeInTheDocument();
  });

  // 重启后 CLI 的结束通知已经不在了（它只出现在 stdout 上）：用量只剩 token 数、
  // 耗时只剩「转录里的收尾时刻 - 启动时刻」。两个都要显示出来，而且工具次数不能拿 0 补
  // （「0 次工具」是假数据）。
  it("重启后从转录恢复的用量：token + 耗时，不编工具次数", () => {
    render(
      <AgentCard
        item={agentTool({
          ts: 1_000,
          result: "done",
          subagent: {
            taskId: "task-1",
            agentId: "abc123",
            status: "stopped",
            background: true,
            endedAt: 151_000,
            usage: { totalTokens: 47_200 },
          },
        })}
      />,
    );
    // `formatTokens` 按 1024 进制：47200 → 46.1K。
    expect(screen.getByText(/46\.1K tokens/)).toBeInTheDocument();
    // 150 秒 → 02:30（`formatDuration` 固定分:秒）。
    expect(screen.getByText("02:30")).toBeInTheDocument();
    expect(screen.queryByText(/次工具/)).toBeNull();
  });

  it("点「查看对话」把请求放进 store", () => {
    render(<AgentCard item={agentTool()} />);
    fireEvent.click(screen.getByText("查看对话"));
    expect(useAppStore.getState().subagentView).toMatchObject({ agentId: "abc123", label: "probe child" });
  });

  it("没有 agentId 时不显示「查看对话」（后台任务刚开始）", () => {
    render(
      <AgentCard
        item={agentTool({ subagent: { taskId: "task-1", status: "running", description: "bg" } })}
      />,
    );
    expect(screen.queryByText("查看对话")).toBeNull();
    expect(screen.getByText("停止")).toBeInTheDocument();
  });

  it("完成状态不再显示停止", () => {
    render(
      <AgentCard
        item={agentTool({ result: "done", subagent: { taskId: "task-1", agentId: "a1", status: "completed" } })}
      />,
    );
    expect(screen.queryByText("停止")).toBeNull();
    expect(screen.getByText("完成")).toBeInTheDocument();
  });
});
