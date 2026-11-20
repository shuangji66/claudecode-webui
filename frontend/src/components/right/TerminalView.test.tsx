import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// jsdom 没有 ResizeObserver（组件用它跟着容器尺寸重排终端）。
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

// xterm 在 jsdom 里建不起来（canvas 尺寸测量、DOM 层都要真浏览器），这里只验证
// 外壳与底栏的布局契约，终端实例本身用空壳顶掉。
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    open() {}
    focus() {}
    write() {}
    dispose() {}
    loadAddon() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../transport/terminal", () => ({
  TerminalConnection: class {
    connect() {}
    close() {}
    resize() {}
    sendInput() {}
  },
}));

import TerminalView from "./TerminalView";

describe("TerminalView 底栏", () => {
  it("移动端底栏留出底部安全区，桌面端回落成普通内边距", () => {
    render(<TerminalView cwd="/vol1/1000/demo" active />);

    // 底栏是屏幕最下面那一行：不留安全区，iPhone 的 Home Indicator 会盖在
    // 「已连接 / shell / 目录」这行字上（截图复现过）。
    const bar = screen.getByText("连接中…").closest("div.shrink-0")!;
    expect(bar.className).toContain("pb-[calc(env(safe-area-inset-bottom,0px)+4px)]");
    expect(bar.className).toContain("md:pb-1");
  });
});
