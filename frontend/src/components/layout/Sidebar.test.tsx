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

describe("Sidebar 会话行的管理入口", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      workspaces: [{ path: "/w/demo", name: "demo", last_used: "", exists: true }],
      currentWorkspace: "/w/demo",
      activeId: null,
      conversations: [
        {
          id: "c-menu",
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

  // 参照 DSH：右键会话行等同于点右上角那个「···」，不用先瞄准只有悬停才出现的按钮。
  it("右键会话行弹出与管理按钮相同的菜单", () => {
    const archiveConversation = vi.fn(async () => true);
    useAppStore.setState({ archiveConversation });

    renderSidebar();
    const more = screen.getByRole("button", { name: "管理对话 会话甲" });
    const row = more.parentElement!;
    // fireEvent 返回 false 表示 preventDefault 被调用过：浏览器原生右键菜单不能同时冒出来。
    expect(fireEvent.contextMenu(row)).toBe(false);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(archiveConversation).toHaveBeenCalledWith("c-menu", true);
  });

  // 两套显示状态都靠 CSS：桌面默认只露时间，悬停 / 聚焦 / 菜单打开时换成「归档 · 置顶 · ⋯」；
  // 触屏没有 hover，时间与「⋯」常驻（归档/置顶只能从菜单点）。jsdom 不算媒体查询，
  // 只能钉住这一组类名，防止被改回「始终显示」或「悬停时按钮盖住标题」。
  it("桌面默认显示时间、悬停露出操作组；触屏只常驻时间与「⋯」", () => {
    renderSidebar();
    const more = screen.getByRole("button", { name: "管理对话 会话甲" });
    const actions = more.parentElement!;
    const row = actions.parentElement!;
    expect(row.className).toContain("group/session");
    expect(actions).toBe(row.lastElementChild);
    expect(actions.className).toContain("md:hidden");
    expect(actions.className).toContain("md:group-hover/session:flex");

    // 归档 / 置顶只在桌面出现（触屏走菜单）。
    for (const name of ["归档 会话甲", "置顶 会话甲"]) {
      expect(screen.getByRole("button", { name }).className).toContain("hidden");
      expect(screen.getByRole("button", { name }).className).toContain("md:inline-flex");
    }

    const time = row.querySelector("button .ml-auto");
    expect(time).not.toBeNull();
    expect(time!.className).toContain("md:group-hover/session:hidden");
  });

  // 行内按钮即点即生效：归档不动转录（软删除），置顶只是列表偏好。
  it("行内的归档与置顶按钮直接改对话状态", () => {
    const archiveConversation = vi.fn(async () => true);
    const pinConversation = vi.fn(async () => true);
    useAppStore.setState({ archiveConversation, pinConversation });

    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "归档 会话甲" }));
    expect(archiveConversation).toHaveBeenCalledWith("c-menu", true);

    fireEvent.click(screen.getByRole("button", { name: "置顶 会话甲" }));
    expect(pinConversation).toHaveBeenCalledWith("c-menu", true);
  });

  // 「复制 Session ID」暂时下线（SHOW_COPY_SESSION_ID=false）：实现与「复制到剪贴板」的
  // 失败回落都还在，只是不在菜单里露出来。恢复时把开关改回 true，并把这个断言反过来。
  it("复制 Session ID 已下线，菜单里不出现", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "管理对话 会话甲" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /复制 Session ID/ })).toBeNull();
  });

  // 分叉：复制上下文到新会话，标题加后缀便于在列表里区分（原对话一字不动）。
  it("菜单里的分叉会话带上「（分叉）」标题", () => {
    const forkConversation = vi.fn(async () => true);
    useAppStore.setState({ forkConversation });

    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "管理对话 会话甲" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "分叉会话" }));
    expect(forkConversation).toHaveBeenCalledWith("c-menu", "会话甲（分叉）");
  });

  // 菜单里也有置顶（触屏唯一入口）。
  it("菜单里的置顶项可用", () => {
    const pinConversation = vi.fn(async () => true);
    useAppStore.setState({ pinConversation });

    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "管理对话 会话甲" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
    expect(pinConversation).toHaveBeenCalledWith("c-menu", true);
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
