import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../../store/useAppStore";

function renderSidebar(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <Sidebar
      onToggleCollapse={() => {}}
      onOpenSettings={() => {}}
      onAddWorkspace={() => {}}
      onOpenHistory={() => {}}
      {...over}
    />,
  );
}

describe("Sidebar 品牌区", () => {
  beforeEach(() => {
    useAppStore.setState({ conversations: [], workspaces: [], currentWorkspace: "", activeId: null });
  });

  // 点标题/logo 会新建对话太容易误触：品牌区只做标识，「新对话」是独立按钮。
  it("品牌区不是按钮，点了不会新建会话", () => {
    renderSidebar();
    const brand = screen.getByText("Claude Code");
    expect(brand.closest("button")).toBeNull();
    expect(screen.queryByText("CONSOLE")).toBeNull();
  });
});

describe("Sidebar 历史记录入口", () => {
  beforeEach(() => {
    useAppStore.setState({ conversations: [], workspaces: [], currentWorkspace: "", activeId: null });
  });

  // 参照 DSH：功能入口在「新对话」与工作区之间的功能区，一行一个。
  it("历史记录在功能区（工作区上方），点击打开历史", () => {
    const onOpenHistory = vi.fn();
    renderSidebar({ onOpenHistory });

    const button = screen.getByRole("button", { name: "历史记录" });
    fireEvent.click(button);
    expect(onOpenHistory).toHaveBeenCalled();

    // DOM 顺序：历史记录必须排在「工作区」标题之前。
    const workspaces = screen.getByText("工作区");
    expect(button.compareDocumentPosition(workspaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Sidebar 分组/排序/筛选菜单", () => {
  const cwd = "/w/demo";

  function seed() {
    useAppStore.setState({
      workspaces: [{ path: cwd, name: "demo", last_used: "", exists: true }],
      currentWorkspace: cwd,
      activeId: null,
      conversations: [
        {
          id: "c-live",
          cwd,
          title: "会话甲",
          created_at: "",
          last_active: "2026-01-02T00:00:00Z",
          messages: 1,
          archived: false,
          live: false,
        },
        {
          id: "c-old",
          cwd,
          title: "会话乙",
          created_at: "",
          last_active: "2026-01-01T00:00:00Z",
          messages: 1,
          archived: true,
          live: false,
        },
      ],
    });
  }

  const openView = () => fireEvent.click(screen.getByLabelText("分组、排序与筛选"));

  beforeEach(() => {
    localStorage.clear();
    seed();
  });

  it("菜单分三组，默认勾在按工作区 / 最近更新 / 隐藏已归档", () => {
    renderSidebar();
    openView();
    expect(screen.getByText("分组方式")).toBeInTheDocument();
    expect(screen.getByText("排序方式")).toBeInTheDocument();
    expect(screen.getByText("筛选会话")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "按工作区" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "最近更新" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "隐藏已归档" })).toHaveAttribute("aria-checked", "true");
  });

  it("切到「仅显示已归档」后只剩归档对话，选择落到 localStorage", () => {
    renderSidebar();
    expect(screen.getByText("会话甲")).toBeInTheDocument();
    expect(screen.queryByText("会话乙")).toBeNull();

    openView();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /仅显示已归档/ }));

    expect(screen.getByText("会话乙")).toBeInTheDocument();
    expect(screen.queryByText("会话甲")).toBeNull();
    expect(JSON.parse(localStorage.getItem("ccweb-sidebar-view") ?? "{}").archive).toBe("only");
  });

  it("切到「单列表」后不再有工作区分组行", () => {
    const { container } = renderSidebar();
    // 工作区分组行是 title 恰好等于路径的那个按钮；会话行的 title 还带着状态。
    expect(container.querySelector('button[title="/w/demo"]')).not.toBeNull();

    openView();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "单列表" }));

    expect(container.querySelector('button[title="/w/demo"]')).toBeNull();
    expect(screen.getByText("会话甲")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ccweb-sidebar-view") ?? "{}").group).toBe("flat");
  });
});
