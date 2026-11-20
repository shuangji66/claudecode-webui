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

describe("TopBar 后台操作", () => {
  const bg = [
    { taskId: "task-1", toolUseId: "tu1", label: "npm test", toolName: "Bash", progress: 12 },
    { taskId: "", toolUseId: "tu2", label: "看不到 task_id 的后台命令", toolName: "Bash" },
  ];

  it("与子智能体是两个入口：后台操作有自己的图标与列表", () => {
    render(bar({ backgroundTasks: bg }));
    // 两个触发器同时在：子智能体（数量 2）与后台操作（数量 2）。
    expect(screen.getByLabelText("子智能体 2 个")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("后台操作 2 个进行中"));

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("看不到 task_id 的后台命令")).toBeInTheDocument();
    // 后台操作的条目不会被当成子代理列进另一个菜单。
    expect(screen.queryByLabelText(/子智能体 3 个/)).toBeNull();
  });

  it("进行中的可以手动中止，且要就地二次确认", () => {
    const onStop = vi.fn();
    render(bar({ backgroundTasks: bg, onStopTask: onStop }));
    fireEvent.click(screen.getByLabelText("后台操作 2 个进行中"));

    const stop = screen.getAllByLabelText("中止");
    // 只有拿得到 task_id 的那条才有中止按钮：点了只会报错的不摆。
    expect(stop).toHaveLength(1);

    // 第一下只换成该行的确认按钮，不回调、不关菜单（可以接着停别的）。
    fireEvent.click(stop[0]);
    expect(onStop).not.toHaveBeenCalled();
    const confirm = screen.getByLabelText("确认中止");
    expect(screen.getByText("npm test")).toBeInTheDocument();

    // 第二下才真正中止。
    fireEvent.click(confirm);
    expect(onStop).toHaveBeenCalledWith("task-1");
  });

  it("列表清空后入口自动隐藏", () => {
    const { rerender } = render(bar({ backgroundTasks: bg }));
    expect(screen.getByLabelText("后台操作 2 个进行中")).toBeInTheDocument();

    rerender(bar({ backgroundTasks: [] }));
    expect(screen.queryByLabelText(/后台操作/)).toBeNull();
  });

  it("没有后台操作时不会有空入口", () => {
    render(bar({ backgroundTasks: [] }));
    expect(screen.queryByLabelText(/后台操作/)).toBeNull();
  });
});
