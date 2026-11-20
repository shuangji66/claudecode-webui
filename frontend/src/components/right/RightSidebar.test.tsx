import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RightSidebar, RightSidebarDock, clampWidth } from "./RightSidebar";
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

const openStart = () => fireEvent.click(screen.getByRole("button", { name: "回到开始页" }));
const openFiles = () => fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));
const openGit = () => fireEvent.click(screen.getByRole("button", { name: /^Git/ }));
const openTerminal = () => fireEvent.click(screen.getByRole("button", { name: /新建终端/ }));

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

describe("RightSidebar 收起侧栏", () => {
  // 移动端关抽屉是高频动作：卸载会把标签、当前选中项、终端 PTY 一起丢掉。
  // 判定看**外层壳的 class**：jsdom 不加载 Tailwind，`hidden` 不是 computed style，
  // `toBeVisible()` 在这里永远是 true。
  function dock(open: boolean, covered = false) {
    const onClose = vi.fn();
    const r = render(<RightSidebarDock open={open} covered={covered} cwd="/w" onClose={onClose} />);
    const shell = () => screen.getByLabelText("工作区侧栏").parentElement!;
    return {
      onClose,
      shell,
      set: (next: boolean, nextCovered = covered) =>
        r.rerender(<RightSidebarDock open={next} covered={nextCovered} cwd="/w" onClose={onClose} />),
    };
  }

  it("关掉再打开时已打开的标签还在，当前选中的也没变", () => {
    const { onClose, shell, set } = dock(true);
    expect(shell().className).toBe("contents");
    openFiles();
    openStart();
    openGit();
    expect(screen.getByText("GIT")).toBeInTheDocument();

    set(false);
    // 收起：只是隐藏，标签与面板都还在 DOM 里（终端 PTY 才不会被 SIGHUP）。
    expect(shell().className).toBe("hidden");
    expect(screen.getByText("GIT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Git$/ })).toBeInTheDocument();

    set(true);
    expect(shell().className).toBe("contents");
    // Git 仍是选中的那个标签，没有被重置回「文件」或开始页。
    expect(screen.getByText("GIT")).toBeInTheDocument();
    expect(screen.getByText("FILES").closest("div[class='hidden']")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("功能区整页视图盖住时同样只隐藏", () => {
    const { shell, set } = dock(true);
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));
    set(true, true);
    expect(shell().className).toBe("hidden");
    set(true, false);
    expect(shell().className).toBe("contents");
    expect(screen.getByText("FILES")).toBeInTheDocument();
  });

  it("重新可见时补一次数据刷新（收起不再靠重新挂载重拉）", () => {
    const setCwd = vi.fn(async () => {});
    useSidebarStore.setState({ setCwd } as never);
    const { set } = dock(true);
    expect(setCwd).toHaveBeenCalledTimes(1); // 首次挂载
    set(false);
    expect(setCwd).toHaveBeenCalledTimes(1); // 收起不该发请求
    set(true);
    expect(setCwd).toHaveBeenCalledTimes(2);
    expect(setCwd).toHaveBeenLastCalledWith("/w");
  });

  it("从没打开过就不挂载（懒加载 chunk 不该为没开过的侧栏下载）", () => {
    dock(false);
    expect(screen.queryByLabelText("工作区侧栏")).toBeNull();
  });
});

describe("RightSidebar 标签页", () => {
  it("默认停在开始页：三张功能卡片，不自动打开「文件」，也不显示 +", () => {
    setup();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Git/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建终端/ })).toBeInTheDocument();
    expect(screen.queryByText("FILES")).toBeNull();
    expect(screen.queryByText("GIT")).toBeNull();
    // 已经在开始页了，+ 点了不会有任何变化，不摆。
    expect(screen.queryByRole("button", { name: "回到开始页" })).toBeNull();
  });

  it("点开始页的卡片才打开对应标签", () => {
    setup();
    openFiles();
    expect(screen.getByText("FILES")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^文件$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回到开始页" })).toBeInTheDocument();
  });

  it("+ 直接回到开始页，不弹下拉菜单；标签只隐藏不卸载", () => {
    setup();
    openFiles();
    openStart();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    // 文件面板仍在 DOM 里（开始页只是盖在上面），标签按钮也还在。
    expect(screen.getByText("FILES").closest("div[class='hidden']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^文件$/ })).toBeInTheDocument();
  });

  it("从开始页可以开第二个终端，每个终端各自一个标签", async () => {
    setup();
    openTerminal();
    openStart();
    openTerminal();

    expect(screen.getByRole("button", { name: /^bash$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^bash 2$/ })).toBeInTheDocument();
    // 终端是懒加载组件，等它挂载完再数
    await waitFor(() => expect(screen.getAllByText("TERM")).toHaveLength(2));
  });

  it("关掉当前标签后切到相邻标签", () => {
    setup();
    openFiles();
    openStart();
    openGit();

    fireEvent.click(screen.getByRole("button", { name: "关闭 Git" }));

    expect(screen.queryByText("GIT")).toBeNull();
    // 只剩文件标签，且它是可见的那个
    const files = screen.getByText("FILES");
    expect(files.closest("div[class='hidden']")).toBeNull();
  });

  it("关掉所有标签后回到开始页", () => {
    setup();
    openFiles();
    fireEvent.click(screen.getByRole("button", { name: "关闭 文件" }));

    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.queryByText("FILES")).toBeNull();
  });

  // 标签一多就横向溢出。滚动条不画（8px 细条压在 56px 高的标题行下沿），
  // 所以滚轮必须能滚：纵向滚轮换成 scrollLeft，否则用户只能去拖那条看不见的条。
  it("标签行不显示滚动条，且纵向滚轮能横向滚", () => {
    setup();
    openTerminal();
    openStart();
    openTerminal();
    const strip = screen.getByRole("button", { name: /^bash$/ }).closest(".dsh-scroll-none") as HTMLElement;
    expect(strip).not.toBeNull();
    // 不显示滚动条靠的是 dsh-scroll-none（不用 dsh-scroll 那份 8px 细条）。
    expect(strip.className).not.toContain("dsh-scroll ");
    Object.defineProperty(strip, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(strip, "clientWidth", { value: 200, configurable: true });

    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    strip.dispatchEvent(event);

    expect(strip.scrollLeft).toBe(40);
    expect(event.defaultPrevented).toBe(true);
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

  // 拖动条跨在侧栏左边界上（外 4px 落在对话区，内 4px 落在侧栏里）。
  // 不给它层级的话，侧栏内部的面板（Git 的提交框/文件列表、终端的 xterm）会先于它
  // 命中指针：拖到内侧那半截时既没有 col-resize，hover 高亮也被面板背景盖掉一半，
  // 肉眼看到的就是「拖动条在面板边缘断开」。jsdom 不算层叠，只能钉住类名。
  it("拖动条要压在面板内容之上，否则内侧半截收不到指针", () => {
    setViewport(1400);
    render(<RightSidebar cwd="/w" onClose={() => {}} />);
    const handle = screen.getByLabelText("调整侧栏宽度");
    expect(handle.className).toContain("z-20");
    // 仍然是贴在左缘、且跨出侧栏 4px（对话区那一侧也要能拖到）
    expect(handle.className).toContain("-left-1");
  });
});

describe("RightSidebar 换工作区", () => {
  it("换工作区结束终端标签，回到开始页/文件标签，而不是静默重启 shell", async () => {
    const { rerender } = (() => {
      const onClose = vi.fn();
      const r = render(<RightSidebar cwd="/w" onClose={onClose} />);
      return { rerender: (cwd: string) => r.rerender(<RightSidebar cwd={cwd} onClose={onClose} />) };
    })();

    openTerminal();
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
