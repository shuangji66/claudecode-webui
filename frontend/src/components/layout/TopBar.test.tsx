import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TopBar } from "./TopBar";
import type { SubagentEntry } from "../../lib/subagents";
import { useAppStore } from "../../store/useAppStore";

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
  // 实时用量存在全局 store 里：每例结束清掉，别渗到下一个用例（断言失败时也要清）。
  afterEach(() => useAppStore.setState({ subagentTokens: {} }));

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

  it("列表里带 token 消耗与运行时间，类型移到第二行", () => {
    const withUsage: SubagentEntry[] = [
      {
        agentId: "u1",
        taskId: "u1",
        label: "用量子代理",
        type: "Explore",
        status: "completed",
        usage: { totalTokens: 12_800, toolUses: 3, durationMs: 83_000 },
      },
      {
        agentId: "u2",
        taskId: "u2",
        label: "在跑的子代理",
        type: "general-purpose",
        status: "running",
        startedAt: Date.now() - 5_000,
      },
    ];
    render(bar({ subagents: withUsage }));
    fireEvent.click(screen.getByLabelText("子智能体 2 个"));

    // 结束的用 CLI 的用量口径（tokens + duration_ms），运行中的按启动时刻走墙钟。
    expect(screen.getByText("12.5K · 1:23")).toBeInTheDocument();
    expect(screen.getByText("5s")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
  });

  it("结束前也能看到实时用量：转发帧算出来的 token 不像进度事件那样要等工具调用", () => {
    // CLI 的 task_progress 只在子代理调用过工具后才发；纯思考的子代理结束前一条都没有。
    // 实时值来自 --forward-subagent-text 转发的 assistant 帧（store.subagentTokens）。
    useAppStore.setState({ subagentTokens: { s1: { u2: 48_500 } } });
    const running: SubagentEntry[] = [
      {
        agentId: "u2",
        taskId: "u2",
        label: "在跑的子代理",
        type: "general-purpose",
        status: "running",
        startedAt: Date.now() - 5_000,
      },
    ];
    render(bar({ session: { id: "s1", cwd: "/w", state: "ready" }, subagents: running }));
    fireEvent.click(screen.getByLabelText("子智能体 1 个"));
    expect(screen.getByText("47.4K · 5s")).toBeInTheDocument();
  });

  it("列表左侧的状态标记：运行中转圈、完成绿点、被中断主题色、失败红点", () => {
    const all: SubagentEntry[] = [
      { agentId: "r", taskId: "r", label: "在跑", status: "running" },
      { agentId: "c", taskId: "c", label: "跑完了", status: "completed" },
      { agentId: "s", taskId: "s", label: "被打断", status: "stopped" },
      { agentId: "f", taskId: "f", label: "失败了", status: "failed" },
    ];
    render(bar({ subagents: all }));
    fireEvent.click(screen.getByLabelText("子智能体 4 个"));

    const mark = (label: string) =>
      screen.getByText(label).closest("button")!.querySelector("[data-state]");
    // running 是进度环（svg.state-dot-spinner），其余是圆点，状态写在 data-state 上。
    expect(mark("在跑")!.classList.contains("state-dot-spinner")).toBe(true);
    expect(mark("跑完了")!.getAttribute("data-state")).toBe("done");
    expect(mark("被打断")!.getAttribute("data-state")).toBe("brand");
    expect(mark("失败了")!.getAttribute("data-state")).toBe("fail");
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
    {
      taskId: "task-1",
      toolUseId: "tu1",
      label: "npm test",
      toolName: "Bash",
      startedAt: Date.now() - 12_000,
      command: "npm test -- --run",
    },
    { taskId: "", toolUseId: "tu2", label: "看不到 task_id 的后台命令", toolName: "Bash", startedAt: Date.now() - 3_000 },
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

  it("每一行都带运行时间（由启动时刻算，不依赖进度事件）", () => {
    render(bar({ backgroundTasks: bg }));
    fireEvent.click(screen.getByLabelText("后台操作 2 个进行中"));
    expect(screen.getByText("12s")).toBeInTheDocument();
    expect(screen.getByText("3s")).toBeInTheDocument();
  });

  it("点一行就地展开详情（默认折叠），再点收起，菜单不关", () => {
    render(bar({ backgroundTasks: bg }));
    fireEvent.click(screen.getByLabelText("后台操作 2 个进行中"));

    // 默认折叠：详情里的标签一个都不在。
    expect(screen.queryByText("已运行")).toBeNull();

    fireEvent.click(screen.getByText("npm test"));
    expect(screen.getByText("已运行")).toBeInTheDocument();
    expect(screen.getByText("npm test -- --run")).toBeInTheDocument();
    // 菜单还开着：另一条任务仍在列表里。
    expect(screen.getByText("看不到 task_id 的后台命令")).toBeInTheDocument();

    fireEvent.click(screen.getByText("npm test"));
    expect(screen.queryByText("已运行")).toBeNull();
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
    // 中止按钮在行尾，不是「展开详情」那一行：点它不该顺带把详情展开。
    expect(screen.queryByText("已运行")).toBeNull();

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
