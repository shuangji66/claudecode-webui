import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FeaturePage } from "./FeaturePage";

// 三个管理页都是懒加载的，一挂载就发请求；这里把 fetch 打桩，免得请求的 setState
// 落在 act 之外。
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("功能区整页视图", () => {
  // 对齐 DSH：功能区入口打开的是整页（接管左侧栏以外的区域），不是居中弹窗。
  it("插件 / MCP / 技能中心都是整页，标题跟着入口走", () => {
    const { unmount } = render(<FeaturePage view="plugins" cwd="" onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "插件" })).toBeInTheDocument();
    unmount();

    render(<FeaturePage view="mcp" cwd="" onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "MCP" })).toBeInTheDocument();
    unmount();

    render(<FeaturePage view="skills" cwd="" onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "技能中心" })).toBeInTheDocument();
  });

  it("页头的关闭按钮回到对话区", () => {
    const onClose = vi.fn();
    render(<FeaturePage view="plugins" cwd="" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 整页视图会盖掉对话区的页头，那时左侧栏在移动端是抽屉，入口只剩页头这一颗。
  it("移动端给打开侧栏的入口（md 以下才显示）", () => {
    const onOpenSidebar = vi.fn();
    render(<FeaturePage view="mcp" cwd="" onClose={() => {}} onOpenSidebar={onOpenSidebar} />);
    const button = screen.getByRole("button", { name: "打开侧栏" });
    expect(button.className).toContain("md:hidden");
    fireEvent.click(button);
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
  });
});
