import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TopBar } from "./TopBar";
import type { SubagentEntry } from "../../lib/subagents";

const subs: SubagentEntry[] = [
  { agentId: "a1", taskId: "a1", label: "先看代码", type: "Explore", status: "running" },
  { agentId: "a2", taskId: "a2", label: "写文件", type: "general-purpose", status: "completed" },
];

function bar(over: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  return (
    <TopBar
      session={null}
      title="t"
      busy={false}
      subagents={subs}
      onOpenSubagent={() => {}}
      onToggleSidebar={() => {}}
      onToggleCollapse={() => {}}
      onOpenSettings={() => {}}
      onCopySession={async () => true}
      rightOpen={false}
      onToggleRight={() => {}}
      {...over}
    />
  );
}

describe("TopBar 子智能体", () => {
  it("有子代理时显示数量，点开能看到列表并打开对话", () => {
    const onOpen = vi.fn();
    render(bar({ onOpenSubagent: onOpen }));
    const trigger = screen.getByLabelText("子智能体 2 个");
    fireEvent.click(trigger);
    expect(screen.getByText("先看代码")).toBeInTheDocument();
    fireEvent.click(screen.getByText("先看代码"));
    expect(onOpen).toHaveBeenCalledWith("a1", "先看代码");
  });

  it("没有子代理时不显示触发器", () => {
    render(bar({ subagents: [] }));
    expect(screen.queryByLabelText(/子智能体/)).toBeNull();
  });
});
