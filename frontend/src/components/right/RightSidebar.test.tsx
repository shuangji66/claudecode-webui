import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RightSidebar, type RightTab } from "./RightSidebar";

// 面板本身另有实现细节（文件树 / Git / xterm），这里只验证右侧栏自己的开合逻辑。
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div>FILES</div> }));
vi.mock("./GitPanel", () => ({ GitPanel: () => <div>GIT</div> }));
vi.mock("./TerminalPanel", () => ({ default: () => <div>TERM</div> }));

beforeEach(() => {
  localStorage.clear();
});

function setup(activeTab: RightTab | null) {
  const onTab = vi.fn();
  const onClose = vi.fn();
  const view = render(<RightSidebar cwd="/w" activeTab={activeTab} onTab={onTab} onClose={onClose} />);
  return { onTab, onClose, view };
}

describe("RightSidebar", () => {
  it("没有打开面板时是启动页：三张入口卡片，不是常驻标签栏", () => {
    setup(null);
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Git/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建终端/ })).toBeInTheDocument();
    // 面板内容一个都不该渲染
    expect(screen.queryByText("FILES")).toBeNull();
    expect(screen.queryByText("GIT")).toBeNull();
    expect(screen.queryByText("TERM")).toBeNull();
  });

  it("点卡片才打开对应面板", () => {
    const { onTab } = setup(null);
    fireEvent.click(screen.getByRole("button", { name: /Git/ }));
    expect(onTab).toHaveBeenCalledWith("git");
  });

  it("面板头部可以返回启动页", () => {
    const { onTab } = setup("git");
    expect(screen.getByText("GIT")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onTab).toHaveBeenCalledWith(null);
  });

  it("打开过的面板切走后仍然挂载，只是隐藏（终端 PTY 不能被卸载）", () => {
    const { view } = setup("git");
    expect(screen.getByText("GIT")).toBeInTheDocument();

    view.rerender(<RightSidebar cwd="/w" activeTab="files" onTab={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText("FILES")).toBeInTheDocument();
    // 仍留在 DOM 里，只是外层被 hidden 掉
    const git = screen.getByText("GIT");
    expect(git.closest("div[class='hidden']")).not.toBeNull();
  });
});
