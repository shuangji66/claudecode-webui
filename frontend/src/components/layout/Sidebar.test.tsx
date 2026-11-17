import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("Sidebar 会话悬浮预览", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      workspaces: [{ path: "/w/demo", name: "demo", last_used: "", exists: true }],
      currentWorkspace: "/w/demo",
      activeId: null,
      conversations: [
        {
          id: "c-hover",
          cwd: "/w/demo",
          title: "会话甲",
          created_at: "",
          last_active: "2026-01-02T00:00:00Z",
          messages: 2,
          archived: false,
          live: false,
        },
      ],
    });
  });

  it("鼠标悬停一会儿弹出最近一问一答", async () => {
    vi.useFakeTimers();
    const loadPreview = vi.fn(async () => ({ user: "问一下", assistant: "答一下" }));
    useAppStore.setState({ loadPreview });

    renderSidebar();
    const row = screen.getByText("会话甲").closest("button");
    expect(row).not.toBeNull();
    fireEvent.pointerEnter(row!, { pointerType: "mouse" });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(loadPreview).toHaveBeenCalledWith("c-hover");
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("问一下");
    expect(tip).toHaveTextContent("答一下");

    fireEvent.pointerLeave(row!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });
});

describe("Sidebar 新建对话后关闭移动端抽屉", () => {
  const path = "/w/demo";

  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      workspaces: [{ path, name: "demo", last_used: "", exists: true }],
      currentWorkspace: path,
      activeId: null,
      starting: false,
      conversations: [],
    });
  });

  // 抽屉里的「新对话」在手机上必须让出位置，否则点完还挡在对话上面。
  it("主「新对话」按钮调 onClose", () => {
    const onClose = vi.fn();
    const createSession = vi.fn(async () => {});
    useAppStore.setState({ createSession });

    renderSidebar({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    expect(createSession).toHaveBeenCalledWith(path);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 工作区行上的「+」也是新建对话的入口，行为必须一致。
  it("工作区行的「+」新建对话后调 onClose", () => {
    const onClose = vi.fn();
    const startConversationIn = vi.fn(async () => {});
    useAppStore.setState({ startConversationIn });

    renderSidebar({ onClose });
    fireEvent.click(screen.getByRole("button", { name: `在该工作区新建对话 ${path}` }));

    expect(startConversationIn).toHaveBeenCalledWith(path);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 桌面侧栏不传 onClose，逻辑不能因此报错。
  it("没有 onClose 时照常新建", () => {
    const createSession = vi.fn(async () => {});
    useAppStore.setState({ createSession });

    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    expect(createSession).toHaveBeenCalledWith(path);
  });
});

describe("Sidebar 工作区行与移动端抽屉", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      workspaces: [
        { path: "/w/demo", name: "demo", last_used: "", exists: true },
        { path: "/w/other", name: "other", last_used: "", exists: true },
      ],
      currentWorkspace: "/w/demo",
      activeId: null,
      conversations: [],
    });
  });

  // 展开/收起一组的会话列表不是导航，抽屉不该被收掉——否则刚展开的就看不见了。
  it("点当前工作区只切换展开，不关抽屉、不切工作区", () => {
    const onClose = vi.fn();
    const switchWorkspace = vi.fn(async () => {});
    useAppStore.setState({ switchWorkspace });

    renderSidebar({ onClose });
    const row = screen.getByTitle("/w/demo");
    const expandedBefore = row.getAttribute("aria-expanded");

    fireEvent.click(row);

    expect(row.getAttribute("aria-expanded")).not.toBe(expandedBefore);
    expect(switchWorkspace).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // 真的换了工作区（会打开那个目录的最近对话）才是导航，这时收抽屉。
  it("点别的工作区会切过去并关抽屉", () => {
    const onClose = vi.fn();
    const switchWorkspace = vi.fn(async () => {});
    useAppStore.setState({ switchWorkspace });

    renderSidebar({ onClose });
    fireEvent.click(screen.getByTitle("/w/other"));

    expect(switchWorkspace).toHaveBeenCalledWith("/w/other");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
