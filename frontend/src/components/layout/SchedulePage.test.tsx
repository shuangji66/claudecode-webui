import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchedulePage } from "./SchedulePage";
import { useAppStore } from "../../store/useAppStore";
import { useScheduleStore } from "../../store/useScheduleStore";
import type { ScheduleTask } from "../../transport/types";

const task: ScheduleTask = {
  id: "t1",
  name: "每日巡检",
  prompt: "跑一遍测试",
  target: { kind: "new-reuse" },
  workspace: "/w/demo",
  rule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
  status: "active",
  next_run: "2026-11-19T01:00:00Z",
  created_at: "2026-11-18T00:00:00Z",
  updated_at: "2026-11-18T00:00:00Z",
};

beforeEach(() => {
  useAppStore.setState({
    workspaces: [{ path: "/w/demo", name: "demo", last_used: "", exists: true }],
    currentWorkspace: "/w/demo",
  });
  // 面板一打开就 load()；测试里不发请求，直接给一份数据。
  useScheduleStore.setState({
    tasks: [task],
    error: null,
    loading: false,
    saving: false,
    load: async () => {},
  });
});

describe("SchedulePage", () => {
  it("列表显示名称、状态与规则摘要", () => {
    render(<SchedulePage onClose={() => {}} />);
    expect(screen.getByText("每日巡检")).toBeTruthy();
    expect(screen.getByText("已开启")).toBeTruthy();
    expect(screen.getByText("每天 09:00")).toBeTruthy();
  });

  it("点任务进入编辑态，点「返回列表」回来", () => {
    render(<SchedulePage onClose={() => {}} />);
    fireEvent.click(screen.getByText("每日巡检"));
    expect(screen.getByText("任务名称")).toBeTruthy();
    expect(screen.getByText("保存修改")).toBeTruthy();
    fireEvent.click(screen.getByText("返回列表"));
    expect(screen.getByText("已开启")).toBeTruthy();
  });

  it("「新建」打开空白编辑器，创建按钮在", () => {
    render(<SchedulePage onClose={() => {}} />);
    fireEvent.click(screen.getByText("新建"));
    expect(screen.getByText("任务内容")).toBeTruthy();
    expect(screen.getByText("创建")).toBeTruthy();
    // 新建态没有「立即执行 / 暂停 / 删除」。
    expect(screen.queryByText("立即执行")).toBeNull();
  });

  // 功能区页头的动作统一：主要动作 = 主题色 + sm（与 MCP 的「添加」、模型页的「保存」
  // 完全同一套 Button 尺寸），次要动作（返回列表）是 ghost sm——以前这里是 md 的
  // 默认按钮 + 手写 `<button>`，和相邻页放一起时大小与颜色都不一致。
  it("页头动作用统一尺寸与主题色", () => {
    render(<SchedulePage onClose={() => {}} />);
    const primary = screen.getByRole("button", { name: "新建" });
    const primaryClasses = primary.className.split(/\s+/);
    expect(primaryClasses).toContain("bg-brand");
    expect(primaryClasses).toContain("px-2.5");
    expect(primaryClasses).toContain("py-1.5");

    fireEvent.click(primary);
    const back = screen.getByRole("button", { name: "返回列表" });
    const backClasses = back.className.split(/\s+/);
    expect(backClasses).not.toContain("bg-brand");
    expect(backClasses).toContain("px-2.5");
  });

  it("列表为空时给一句人话", () => {
    useScheduleStore.setState({ tasks: [] });
    render(<SchedulePage onClose={() => {}} />);
    expect(screen.getByText(/还没有自动化任务/)).toBeTruthy();
  });

  // 整页视图（不再是弹窗）：页头 h-14 与对话区对齐，动作在页头右侧，
  // 内容区自己滚动、自己留安全区——「返回列表 / 新建」不再沉在屏幕最下方。
  it("整页视图：页头动作 + 可滚动内容区", () => {
    render(<SchedulePage onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "自动化任务" })).toBeTruthy();

    const body = screen.getByText("每日巡检").closest(".dsh-scroll") as HTMLElement;
    expect(body).toBeTruthy();
    // 三条缺一不可：`flex-1` 拿到剩余高度、`min-h-0` 允许它被压到视口内（否则 flex 子项
    // 按内容撑开、`overflow-y-auto` 永远没有溢出，手指划它不会有反应——技能页踩过同一个坑）、
    // `overflow-y-auto` 才是滚动容器本身（滚动归属的约定见 frontend/AGENTS.md 26.1）。
    const bodyClasses = body.className.split(/\s+/);
    expect(bodyClasses).toContain("flex-1");
    expect(bodyClasses).toContain("min-h-0");
    expect(bodyClasses).toContain("overflow-y-auto");
    expect(body.className).toContain("px-4");
    expect(body.className).toContain("pb-[calc(env(safe-area-inset-bottom");
  });

  it("页头的关闭按钮回到对话区", () => {
    const onClose = vi.fn();
    render(<SchedulePage onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 运行记录里点一条对话：打开了才回对话区（与历史记录页同一条规矩），
  // 打不开就留在这一页——否则功能页盖在上面，用户以为点了没反应。
  it("运行记录里打开对话成功才回对话区", async () => {
    const onClose = vi.fn();
    const openConversation = vi.fn(async () => true);
    useAppStore.setState({ openConversation });
    useScheduleStore.setState({
      deliveries: async () => [{ at: "2026-11-19T01:00:00Z", conversation_id: "c-9", prompt: "跑一遍测试" }],
    });

    render(<SchedulePage onClose={onClose} />);
    fireEvent.click(screen.getByText("每日巡检"));

    fireEvent.click(await screen.findByText("c-9"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(openConversation).toHaveBeenCalledWith("c-9");
  });

  it("对话打不开时留在自动化任务页", async () => {
    const onClose = vi.fn();
    const openConversation = vi.fn(async () => false);
    useAppStore.setState({ openConversation });
    useScheduleStore.setState({
      deliveries: async () => [{ at: "2026-11-19T01:00:00Z", conversation_id: "c-9", prompt: "跑一遍测试" }],
    });

    render(<SchedulePage onClose={onClose} />);
    fireEvent.click(screen.getByText("每日巡检"));
    fireEvent.click(await screen.findByText("c-9"));

    await waitFor(() => expect(openConversation).toHaveBeenCalledWith("c-9"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

vi.mock("../../lib/runtime", async (orig) => {
  const actual = await orig<typeof import("../../lib/runtime")>();
  return { ...actual, apiFetch: vi.fn(async () => ({ tasks: [] })) };
});
