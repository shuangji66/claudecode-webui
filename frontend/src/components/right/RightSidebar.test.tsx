import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RightSidebar } from "./RightSidebar";

// 面板本身另有实现细节（文件树 / Git / xterm），这里只验证标签页自己的开合逻辑。
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div>FILES</div> }));
vi.mock("./GitPanel", () => ({ GitPanel: () => <div>GIT</div> }));
vi.mock("./TerminalView", () => ({ default: () => <div>TERM</div> }));

beforeEach(() => {
  localStorage.clear();
});

function setup() {
  const onClose = vi.fn();
  render(<RightSidebar cwd="/w" onClose={onClose} />);
  return { onClose };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "新建标签" }));

describe("RightSidebar 标签页", () => {
  it("默认停在开始页：三张功能卡片，不自动打开「文件」", () => {
    setup();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Git/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建终端/ })).toBeInTheDocument();
    expect(screen.queryByText("FILES")).toBeNull();
    expect(screen.queryByText("GIT")).toBeNull();
  });

  it("点开始页的卡片才打开对应标签", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));
    expect(screen.getByText("FILES")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^文件$/ })).toBeInTheDocument();
  });

  it("+ 菜单打开 Git 标签，切走时文件标签仍在 DOM 里（只隐藏）", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Git/ }));

    expect(screen.getByText("GIT")).toBeInTheDocument();
    const files = screen.getByText("FILES");
    expect(files.closest("div[class='hidden']")).not.toBeNull();
  });

  it("终端每次打开都是独立标签", async () => {
    setup();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /终端/ }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /终端/ }));

    expect(screen.getByRole("button", { name: /^bash$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^bash 2$/ })).toBeInTheDocument();
    // 终端是懒加载组件，等它挂载完再数
    await waitFor(() => expect(screen.getAllByText("TERM")).toHaveLength(2));
  });

  it("关掉当前标签后切到相邻标签", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Git/ }));

    fireEvent.click(screen.getByRole("button", { name: "关闭 Git" }));

    expect(screen.queryByText("GIT")).toBeNull();
    // 只剩文件标签，且它是可见的那个
    const files = screen.getByText("FILES");
    expect(files.closest("div[class='hidden']")).toBeNull();
  });

  it("关掉所有标签后回到开始页", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));
    fireEvent.click(screen.getByRole("button", { name: "关闭 文件" }));

    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.queryByText("FILES")).toBeNull();
  });
});
