import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("px-4");
    expect(body.className).toContain("pb-[calc(env(safe-area-inset-bottom");
  });

  it("页头的关闭按钮回到对话区", () => {
    const onClose = vi.fn();
    render(<SchedulePage onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

vi.mock("../../lib/runtime", async (orig) => {
  const actual = await orig<typeof import("../../lib/runtime")>();
  return { ...actual, apiFetch: vi.fn(async () => ({ tasks: [] })) };
});
