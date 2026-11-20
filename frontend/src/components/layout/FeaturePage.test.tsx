import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FeaturePage } from "./FeaturePage";
import { useAppStore } from "../../store/useAppStore";

// 各页都是懒加载的，一挂载就发请求；这里把 fetch 打桩，免得请求的 setState
// 落在 act 之外。
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("功能区整页视图", () => {
  // 对齐 DSH：功能区入口打开的是整页（接管左侧栏以外的区域），不是居中弹窗。
  it("模型 / 插件 / MCP / 技能中心都是整页，标题跟着入口走", async () => {
    const { unmount } = render(<FeaturePage view="models" cwd="" onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // 模型页是懒加载的 chunk，页头随它一起到。
    expect(await screen.findByRole("heading", { name: "模型" })).toBeInTheDocument();
    unmount();

    render(<FeaturePage view="plugins" cwd="" onClose={() => {}} />);
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

  // 模型页从设置页签整页搬过来：页面自己不再画「模型」标题，标题只由 PageShell 给一份。
  it("模型页只有页头一个「模型」标题", async () => {
    useAppStore.setState({ settings: null, settingsSaving: false });
    await act(async () => {
      render(<FeaturePage view="models" cwd="" onClose={() => {}} />);
    });
    expect(await screen.findAllByText("模型", { selector: "h1" })).toHaveLength(1);
  });

  // 保存是这一页唯一的整体动作：放页头右侧，正文底部不再有按钮行与分隔线。
  it("模型页的保存按钮在页头，页面底部没有第二个保存键", async () => {
    useAppStore.setState({
      settings: { providers: [], selected: { provider: "", model: "", effort: "" } } as never,
      settingsSaving: false,
    });
    const { container } = render(<FeaturePage view="models" cwd="" onClose={() => {}} />);
    const save = await screen.findByRole("button", { name: "保存" });
    // 在 <header> 里，而不是正文末尾。
    expect(save.closest("header")).not.toBeNull();
    expect(container.querySelectorAll("header button[aria-label='保存']")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "保存模型设置" })).toBeNull();
    // 页脚那条分隔线（border-t + 保存行）已经删掉：正文里不再有独立的分隔条。
    expect(container.querySelector(".border-t")).toBeNull();
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
