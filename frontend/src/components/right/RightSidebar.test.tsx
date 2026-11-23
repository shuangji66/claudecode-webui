import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RightSidebar, RightSidebarDock, clampWidth } from "./RightSidebar";
import { useSidebarStore } from "../../store/useSidebarStore";
import { useAppStore } from "../../store/useAppStore";

// 面板本身另有实现细节（文件树 / Git / xterm），这里只验证标签页自己的开合逻辑。
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div>FILES</div> }));
vi.mock("./GitPanel", () => ({ GitPanel: () => <div>GIT</div> }));
vi.mock("./TerminalView", () => ({ default: () => <div>TERM</div> }));
vi.mock("./SubagentPanel", () => ({ SubagentPanel: () => <div>SUB</div> }));
vi.mock("./TracePanel", () => ({
  TracePanel: ({ onJump }: { onJump?: () => void }) => (
    <div>
      TRACE
      <button type="button" onClick={() => onJump?.()}>
        JUMP
      </button>
    </div>
  ),
}));

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
const openTrace = () => fireEvent.click(screen.getByRole("button", { name: /执行轨迹/ }));

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
    expect(screen.getByText("FILES").closest("div.hidden")).not.toBeNull();
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
  it("默认停在开始页：四张功能卡片，不自动打开「文件」，也不显示 +", () => {
    setup();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Git/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行轨迹/ })).toBeInTheDocument();
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

  // 终端一多，标签条会横向滚出去：`+` 跟着滚走就再也回不到开始页了，
  // 所以它必须在滚动容器**外面**（对齐 DSH 的 panel chrome）。
  it("+ 固定在标签滚动区之外", () => {
    setup();
    openFiles();
    const plus = screen.getByRole("button", { name: "回到开始页" });
    expect(plus.closest(".overflow-x-auto")).toBeNull();
  });

  it("+ 直接回到开始页，不弹下拉菜单；标签只隐藏不卸载", () => {
    setup();
    openFiles();
    openStart();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();
    // 文件面板仍在 DOM 里（开始页只是盖在上面），标签按钮也还在。
    expect(screen.getByText("FILES").closest("div.hidden")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^文件$/ })).toBeInTheDocument();
  });

  it("轨迹标签是单例：再点一次卡片只切回去，不会开第二份", () => {
    setup();
    openTrace();
    expect(screen.getByText("TRACE")).toBeInTheDocument();
    openStart();
    openTrace();
    expect(screen.getAllByRole("button", { name: /^轨迹/ })).toHaveLength(1);
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
    expect(files.closest("div.hidden")).toBeNull();
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

describe("RightSidebar 切对话时关掉别的对话的子代理", () => {
  // 子代理标签带着打开时的 sessionId：切到另一条对话之后它读的还是上一段对话的子代理
  // 转录，右边挂着一份与眼前这一轮毫无关系的内容（用户报过）。
  beforeEach(() => {
    useSidebarStore.setState({ openRequest: null, cwd: "/w" });
    useAppStore.setState({ subagentView: null, activeId: "sess-1" });
  });

  it("切走之后那个标签没了，同一条对话里再切回来也不会自己回来", () => {
    const r = render(<RightSidebar cwd="/w" onClose={() => {}} />);
    act(() => useAppStore.setState({ subagentView: { agentId: "agent-1", label: "researcher", nonce: 1 } }));
    expect(screen.getByText("SUB")).toBeInTheDocument();

    // 切到另一条对话：标签被关掉，这一栏回到开始页（它是唯一那个标签）。
    act(() => useAppStore.setState({ activeId: "sess-2" }));
    expect(screen.queryByText("SUB")).toBeNull();
    expect(screen.getByRole("button", { name: /工作区文件/ })).toBeInTheDocument();

    // 切回原对话：子代理标签不会自己长回来（重新打开仍是用户显式动作）。
    act(() => useAppStore.setState({ activeId: "sess-1" }));
    expect(screen.queryByText("SUB")).toBeNull();
    r.unmount();
  });

  it("文件 / Git 标签不受影响（它们跟着工作区走，不跟对话）", () => {
    render(<RightSidebar cwd="/w" onClose={() => {}} />);
    openFiles();
    // 开完「文件」就进标签页了，开始页的卡片不在屏幕上：先点 `+` 回开始页再开 Git。
    openStart();
    openGit();
    act(() => useAppStore.setState({ activeId: "sess-2" }));
    expect(screen.getByText("FILES")).toBeInTheDocument();
    expect(screen.getByText("GIT")).toBeInTheDocument();
  });
});

describe("RightSidebar 桌面全屏与分栏", () => {
  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  }

  beforeEach(() => {
    setViewport(1400);
  });

  it("全屏铺满视口，再点一次恢复停靠宽度", () => {
    const onClose = vi.fn();
    render(<RightSidebar cwd="/w" onClose={onClose} />);
    const aside = () => screen.getByLabelText("工作区侧栏");

    fireEvent.click(screen.getByRole("button", { name: "全屏" }));
    expect(aside().className).toContain("fixed inset-0");
    expect(aside().className).toContain("w-full");
    // 全屏时不再有宽度拖动条（宽度不再由用户值决定）。
    expect(screen.getByLabelText("调整侧栏宽度")).toHaveClass("hidden");
    // 偏好落在浏览器本地：重开侧栏仍是全屏。
    expect(localStorage.getItem("ccweb-right-fullscreen")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(aside().className).toContain("w-[var(--right-w)]");
    expect(screen.getByLabelText("调整侧栏宽度")).not.toHaveClass("hidden");
  });

  it("两栏可以同时打开文件与 Git（一边一个）", () => {
    setup();
    openGit(); // A 栏：Git
    fireEvent.click(screen.getByRole("button", { name: "分栏" }));
    // B 栏的开始页开文件：A 栏的 Git 不受影响。
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ }));

    expect(screen.getByText("GIT").closest("div.hidden")).toBeNull();
    expect(screen.getByText("FILES").closest("div.hidden")).toBeNull();
    expect(screen.getAllByText("FILES")).toHaveLength(1);
    expect(screen.getAllByText("GIT")).toHaveLength(1);
  });

  it("同一个面板也能两栏各开一份，关栏时重复的那份丢掉", () => {
    setup();
    openFiles(); // A 栏：文件
    fireEvent.click(screen.getByRole("button", { name: "分栏" }));
    fireEvent.click(screen.getByRole("button", { name: /工作区文件/ })); // B 栏：再来一份

    expect(screen.getAllByText("FILES")).toHaveLength(2);
    for (const node of screen.getAllByText("FILES")) {
      expect(node.closest("div.hidden")).toBeNull();
    }

    // 并回一栏：A 栏已经有文件面板，B 栏那份副本丢掉，只留一份。
    fireEvent.click(screen.getByRole("button", { name: "关闭这一栏" }));
    expect(screen.queryByRole("separator", { name: "调整两栏宽度" })).toBeNull();
    expect(screen.getAllByText("FILES")).toHaveLength(1);
    expect(screen.getByText("FILES").closest("div.hidden")).toBeNull();
  });

  it("并栏时终端标签只改归属，不重挂（PTY 不会被杀）", async () => {
    setup();
    openFiles(); // A 栏有标签，分栏后只有 B 栏显示开始页
    fireEvent.click(screen.getByRole("button", { name: "分栏" }));
    // B 栏开一个终端
    fireEvent.click(screen.getByRole("button", { name: /新建终端/ }));
    const term = await screen.findByText("TERM");

    fireEvent.click(screen.getByRole("button", { name: "关闭这一栏" }));
    await waitFor(() => expect(screen.getByText("TERM")).toBe(term));
    expect(screen.getAllByText("TERM")).toHaveLength(1);
  });

  it("窄屏（浮层）下不出现全屏/分栏入口", () => {
    setViewport(900);
    setup();
    expect(screen.queryByRole("button", { name: "分栏" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全屏" })).toBeNull();
  });
});

// 轨迹里点一步的意义是「带我去看那一条」：对话区在后面滚过去了，但面板还盖着。
describe("RightSidebar 轨迹跳转后收起遮挡层", () => {
  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  }

  const jump = () => fireEvent.click(screen.getByRole("button", { name: "JUMP" }));

  it("移动端抽屉里点一步会关掉侧栏", () => {
    setViewport(900);
    const onClose = vi.fn();
    render(<RightSidebar cwd="/w" onClose={onClose} />);
    openTrace();
    jump();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("桌面全屏下点一步也会退出遮挡", () => {
    setViewport(1400);
    const onClose = vi.fn();
    render(<RightSidebar cwd="/w" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "全屏" }));
    openTrace();
    jump();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 停靠时侧栏不遮挡对话区：收起来反而把用户正在看的轨迹藏掉，
  // 而对话区那边已经滚过去了，谁也说不清「刚才点的那一步在哪」。
  it("桌面停靠时不关（不遮挡对话区）", () => {
    setViewport(1400);
    const onClose = vi.fn();
    render(<RightSidebar cwd="/w" onClose={onClose} />);
    openTrace();
    jump();
    expect(onClose).not.toHaveBeenCalled();
  });
});
