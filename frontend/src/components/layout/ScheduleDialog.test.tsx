import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScheduleDialog } from "./ScheduleDialog";
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

describe("ScheduleDialog", () => {
  it("列表显示名称、状态与规则摘要", () => {
    render(<ScheduleDialog open onClose={() => {}} />);
    expect(screen.getByText("每日巡检")).toBeTruthy();
    expect(screen.getByText("已开启")).toBeTruthy();
    expect(screen.getByText("每天 09:00")).toBeTruthy();
  });

  it("点任务进入编辑态，点「返回列表」回来", () => {
    render(<ScheduleDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByText("每日巡检"));
    expect(screen.getByText("任务名称")).toBeTruthy();
    expect(screen.getByText("保存修改")).toBeTruthy();
    fireEvent.click(screen.getByText("返回列表"));
    expect(screen.getByText("已开启")).toBeTruthy();
  });

  it("「新建」打开空白编辑器，创建按钮在", () => {
    render(<ScheduleDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByText("新建"));
    expect(screen.getByText("任务内容")).toBeTruthy();
    expect(screen.getByText("创建")).toBeTruthy();
    // 新建态没有「立即执行 / 暂停 / 删除」。
    expect(screen.queryByText("立即执行")).toBeNull();
  });

  it("列表为空时给一句人话", () => {
    useScheduleStore.setState({ tasks: [] });
    render(<ScheduleDialog open onClose={() => {}} />);
    expect(screen.getByText(/还没有自动化任务/)).toBeTruthy();
  });

  // 回归：面板最初直接用 Dialog 的默认几何（md 居中、无内边距），表现是
  // ① 列表卡片/输入框的边框正好压在弹窗边框上；② 滚动区贴到页脚分割线，最后一条
  // 卡片的圆角被切掉、看起来像被页脚盖住。现在复用设置弹窗那套：整屏（移动端）/
  // 900×82vh（桌面）+ 内容区自带内边距。
  it("复用设置弹窗的几何与内边距", () => {
    render(<ScheduleDialog open onClose={() => {}} />);
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("h-[100dvh]");
    expect(panel.className).toContain("md:h-[82vh]");
    expect(panel.className).toContain("md:max-w-[900px]");

    const body = screen.getByText("每日巡检").closest(".dsh-scroll") as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("px-4");
    expect(body.className).toContain("pb-4");
    // 页脚是滚动区的兄弟节点（不在滚动区里），滚动内容不会从下面穿过去。
    expect(body.parentElement?.querySelector("footer")).toBeTruthy();
  });

  it("关闭时不渲染内容", () => {
    const { container } = render(<ScheduleDialog open={false} onClose={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

vi.mock("../../lib/runtime", async (orig) => {
  const actual = await orig<typeof import("../../lib/runtime")>();
  return { ...actual, apiFetch: vi.fn(async () => ({ tasks: [] })) };
});
