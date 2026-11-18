import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RightSidebar, clampWidth } from "./RightSidebar";
import { useSidebarStore } from "../../store/useSidebarStore";
import { useAppStore } from "../../store/useAppStore";

// 面板本身另有实现细节（文件树 / Git / xterm），这里只验证标签页自己的开合逻辑。
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div>FILES</div> }));
vi.mock("./GitPanel", () => ({ GitPanel: () => <div>GIT</div> }));
vi.mock("./TerminalView", () => ({ default: () => <div>TERM</div> }));
vi.mock("./SubagentPanel", () => ({ SubagentPanel: () => <div>SUB</div> }));

beforeEach(() => {
  localStorage.clear();
});

function setup() {
  const onClose = vi.fn();
  render(<RightSidebar cwd="/w" onClose={onClose} />);
  return { onClose };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "新建标签" }));

describe("RightSidebar 开始页栅格", () => {
  // 列数按容器宽度切，不看视口：右侧栏是拖出来的，宽度和 viewport 没关系。
  // jsdom 不算容器查询，只能钉住这组类名，防止被人改回写死的两列。
  it("窄了排一列、宽了才两列（容器查询）", () => {
    setup();
    const grid = screen.getByRole("button", { name: /工作区文件/ }).parentElement!;
    expect(grid.parentElement!.className).toContain("@container");
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("@min-[21rem]:grid-cols-2");
  });
});

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

describe("RightSidebar 停靠与宽度", () => {
  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  }

  it("宽度不能把对话区挤到 420px 以下", () => {
    // 1108 - 280(左栏) - 420(对话) = 408
    expect(clampWidth(680, 1108)).toBe(408);
    // 宽屏下用户值说了算
    expect(clampWidth(680, 1600)).toBe(680);
    // 视口再小也不低于最小宽度（此时会切浮层，不参与挤压）
    expect(clampWidth(680, 800)).toBe(300);
  });

  it("窗口缩小时宽度自动收敛，不用等用户拖动", () => {
    localStorage.setItem("ccweb-right-width", "680");
    setViewport(1600);
    render(<RightSidebar cwd="/w" onClose={() => {}} />);
    const aside = screen.getByLabelText("工作区侧栏");
    expect(aside.style.getPropertyValue("--right-w")).toBe("680px");

    // 1600 → 1100：右栏最多 1100 - 280(左栏) - 420(对话) = 400
    setViewport(1100);
    fireEvent(window, new Event("resize"));
    expect(aside.style.getPropertyValue("--right-w")).toBe("400px");
  });

  it("视口够宽才停靠，窄屏改成浮层", () => {
    setViewport(1400);
    const wide = render(<RightSidebar cwd="/w" onClose={() => {}} />);
    expect(screen.getByLabelText("调整侧栏宽度")).not.toHaveClass("hidden");
    wide.unmount();

    setViewport(900);
    render(<RightSidebar cwd="/w" onClose={() => {}} />);
    expect(screen.getByLabelText("调整侧栏宽度")).toHaveClass("hidden");
    setViewport(1024);
  });
});

describe("RightSidebar 换工作区", () => {
  it("换工作区结束终端标签，回到开始页/文件标签，而不是静默重启 shell", async () => {
    const { rerender } = (() => {
      const onClose = vi.fn();
      const r = render(<RightSidebar cwd="/w" onClose={onClose} />);
      return { rerender: (cwd: string) => r.rerender(<RightSidebar cwd={cwd} onClose={onClose} />) };
    })();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /终端/ }));
    await waitFor(() => expect(screen.getAllByText("TERM")).toHaveLength(1));

    rerender("/w2");

    // 终端标签必须消失（旧 shell 的 cwd 不成立，应结束而不是重建）。
    await waitFor(() => expect(screen.queryByText("TERM")).toBeNull());
    expect(screen.queryByRole("button", { name: /^bash/ })).toBeNull();
    // 回到开始页
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
  });
});

describe("RightSidebar 的一次性请求", () => {
  // 两条请求都在 store 里：右侧栏是「关掉就卸载」的，只靠组件内的 ref 记「已处理」
  // 会在重新挂载时归零，把上一次的请求重放一遍。
  beforeEach(() => {
    // 侧栏本来就在 /w 上（生产中关掉再打开时 store 里的 cwd 没变）：这样首次挂载
    // 的 setCwd 不会走到「换 cwd 顺手清请求」的分支，重放问题才暴露得出来。
    useSidebarStore.setState({ openRequest: null, cwd: "/w" });
    useAppStore.setState({ subagentView: null, activeId: "sess-1" });
  });

  it("「在右侧栏打开」消费后关掉侧栏再打开，不会又开「文件」标签", () => {
    useSidebarStore.setState({ openRequest: { path: "probe/quad.png", seq: 1 } });
    const first = render(<RightSidebar cwd="/w" onClose={() => {}} />);
    expect(screen.getByText("FILES")).toBeInTheDocument();
    // 请求已经出队：store 里不再挂着它
    expect(useSidebarStore.getState().openRequest).toBeNull();
    first.unmount();

    render(<RightSidebar cwd="/w" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.queryByText("FILES")).toBeNull();
  });

  it("「查看子代理对话」同样只消费一次", () => {
    useAppStore.setState({ subagentView: { agentId: "agent-1", label: "researcher", nonce: 1 } });
    const first = render(<RightSidebar cwd="/w" onClose={() => {}} />);
    expect(screen.getByText("SUB")).toBeInTheDocument();
    expect(useAppStore.getState().subagentView).toBeNull();
    first.unmount();

    render(<RightSidebar cwd="/w" onClose={() => {}} />);
    expect(screen.queryByText("SUB")).toBeNull();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
  });
});
