import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      onCopySession={async () => true}
      onDownloadSession={async () => true}
      rightOpen={false}
      onToggleRight={() => {}}
      showReveal={false}
      onRevealWorkspace={() => {}}
      {...over}
    />
  );
}

// 页头原来在桌面端也有一颗「收起侧栏」，与侧栏品牌行那颗同一个图标、又紧挨着标题，
// 一眼看不出区别。收起/展开归侧栏自己管，页头只留移动端的抽屉入口。
describe("TopBar 侧栏开关", () => {
  it("只留移动端的「打开侧栏」，不再有桌面的「收起侧栏」", () => {
    render(bar());
    expect(screen.getByLabelText("打开侧栏")).toBeInTheDocument();
    expect(screen.queryByLabelText("收起侧栏")).toBeNull();
  });
});

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

describe("TopBar 更多菜单", () => {
  it("有「下载 Session 日志」，没有「设置」（设置只在侧栏底部）", () => {
    render(bar({ session: { id: "s1", cwd: "/w", state: "ready" } }));
    fireEvent.click(screen.getByLabelText("更多"));
    expect(screen.getByRole("menuitem", { name: /下载 Session 日志/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "设置" })).toBeNull();
    // 复制 Markdown 还在。
    expect(screen.getByRole("menuitem", { name: /复制会话为 Markdown/ })).toBeInTheDocument();
  });

  it("点下载会回调，并在成功后把文案换成「已下载」", async () => {
    const onDownload = vi.fn(async () => true);
    render(bar({ session: { id: "s1", cwd: "/w", state: "ready" }, onDownloadSession: onDownload }));
    fireEvent.click(screen.getByLabelText("更多"));
    fireEvent.click(screen.getByRole("menuitem", { name: /下载 Session 日志/ }));
    await waitFor(() => expect(onDownload).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("更多"));
    expect(await screen.findByRole("menuitem", { name: "已下载" })).toBeInTheDocument();
  });
});

describe("TopBar 在飞牛打开工作区", () => {
  const label = "在飞牛文件管理器中打开工作区";

  it("宿主内显示文件夹按钮，点击调回调", () => {
    const onReveal = vi.fn();
    render(bar({ showReveal: true, onRevealWorkspace: onReveal }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("不在宿主 / 端口访问时不渲染按钮", () => {
    render(bar({ showReveal: false }));
    expect(screen.queryByRole("button", { name: label })).toBeNull();
  });
});
