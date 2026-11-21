import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import { useSidebarStore } from "../../store/useSidebarStore";
import { useAppStore } from "../../store/useAppStore";

/** 文件树请求：按相对目录返回不同的子项，用来验证「刷新后展开状态还在」。 */
const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(async (path: string): Promise<unknown> => {
    const url = new URL(path, "http://localhost");
    if (url.pathname.endsWith("/api/fs/search")) {
      const q = url.searchParams.get("q") ?? "";
      if (q === "read") {
        return {
          entries: [
            { name: "src", path: "src", type: "dir" },
            { name: "README.md", path: "README.md", type: "file", size: 120 },
          ],
          truncated: false,
        };
      }
      return { entries: [], truncated: false };
    }
    if (url.pathname.endsWith("/api/fs/tree")) {
      const dir = url.searchParams.get("path") ?? "";
      if (dir === "") return { entries: [{ name: "frontend", path: "frontend", type: "dir" }] };
      if (dir === "frontend") {
        return { entries: [{ name: "src", path: "frontend/src", type: "dir" }] };
      }
      return { entries: [] };
    }
    return {};
  }),
}));

vi.mock("../../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/runtime")>();
  return { ...actual, apiFetch };
});

const downloadFromUrl = vi.fn(async (_url: string, _name: string) => {});
const downloadInFrame = vi.fn((_url: string) => {});
vi.mock("../../lib/download", () => ({
  downloadFromUrl: (url: string, name: string) => downloadFromUrl(url, name),
  downloadInFrame: (url: string) => downloadInFrame(url),
}));

const CWD = "/vol1/1000/demo";

function seed() {
  useSidebarStore.setState({
    cwd: CWD,
    levels: {
      "": [
        { name: "src", path: "src", type: "dir" },
        { name: "README.md", path: "README.md", type: "file", size: 120 },
      ],
    },
    loading: {},
    truncated: {},
    errors: {},
    hidden: true,
  });
  useAppStore.setState({ mentionRequest: null });
}

function setUA(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

const PLAIN_UA = "Mozilla/5.0 (Macintosh) Chrome/120";
const APP_UA = "Mozilla/5.0 (iPhone) FNAppType/ios FNAppVer/1.38.0";

beforeEach(() => {
  seed();
  downloadFromUrl.mockReset();
  downloadFromUrl.mockResolvedValue(undefined);
  downloadInFrame.mockReset();
  setUA(PLAIN_UA);
});

afterEach(() => {
  setUA(PLAIN_UA);
});

describe("FilesPanel 行菜单", () => {
  it("不在宿主里时给「引用到对话 / 下载 / 复制路径」，不给宿主专属项", () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("更多操作 README.md"));

    expect(screen.getByRole("menuitem", { name: /引用到对话/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /下载/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /复制文件路径/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /在文件夹显示/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /文件详情/ })).toBeNull();
    // 宿主能力不可用时不摆「用默认应用打开」：点了只会报错。
    expect(screen.queryByRole("menuitem", { name: /用默认应用打开/ })).toBeNull();
  });

  it("「引用到对话」把绝对路径与类型交给 store", () => {
    render(<FilesPanel cwd={CWD} active />);

    fireEvent.click(screen.getByLabelText("更多操作 README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: /引用到对话/ }));
    expect(useAppStore.getState().mentionRequest).toMatchObject({
      path: `${CWD}/README.md`,
      kind: "file",
    });

    fireEvent.click(screen.getByLabelText("更多操作 src"));
    fireEvent.click(screen.getByRole("menuitem", { name: /引用到对话/ }));
    expect(useAppStore.getState().mentionRequest).toMatchObject({ path: `${CWD}/src`, kind: "dir" });
  });

  it("文件走 blob 下载（不导航页面），目录走隐藏 iframe", async () => {
    render(<FilesPanel cwd={CWD} active />);

    fireEvent.click(screen.getByLabelText("更多操作 README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: /下载/ }));
    await waitFor(() => expect(downloadFromUrl).toHaveBeenCalledTimes(1));
    const [fileUrl, name] = downloadFromUrl.mock.calls[0] as unknown as [string, string];
    expect(fileUrl).toContain("/api/fs/download?");
    expect(fileUrl).toContain("path=README.md");
    expect(name).toBe("README.md");
    expect(downloadInFrame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("更多操作 src"));
    fireEvent.click(screen.getByRole("menuitem", { name: /下载/ }));
    expect(downloadInFrame).toHaveBeenCalledTimes(1);
    expect(downloadInFrame.mock.calls[0][0]).toContain("path=src");
  });

  it("目录的复制项叫「复制文件夹路径」", () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("更多操作 src"));
    expect(screen.getByRole("menuitem", { name: /复制文件夹路径/ })).toBeInTheDocument();
  });

  it("在飞牛宿主里给全宿主专属项", () => {
    setUA(APP_UA);
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("更多操作 README.md"));

    expect(screen.getByRole("menuitem", { name: /用默认应用打开/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /在文件夹显示/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /复制文件路径/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /文件详情/ })).toBeInTheDocument();

    // 目录不摆这一项：打开目录就是「在文件夹显示」，两条入口会让人不知道点哪条。
    fireEvent.click(screen.getByLabelText("更多操作 src"));
    expect(screen.queryByRole("menuitem", { name: /用默认应用打开/ })).toBeNull();
  });
});

describe("移动端底部安全区", () => {
  // 右侧栏在移动端是全屏抽屉，面板底边就是屏幕底边：不留安全区，文件树最后一行
  // 会被 iPhone 的 Home Indicator 盖住。jsdom 不算 env()，只能钉住这组类名。
  it("整列留出安全区，且树与预览共用同一个根节点", () => {
    render(<FilesPanel cwd={CWD} active />);
    const root = screen.getByText("README.md").closest("div.flex.h-full.min-h-0.flex-col") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain("pb-[calc(env(safe-area-inset-bottom,0px)+8px)]");
  });
});

describe("文件树刷新", () => {
  beforeEach(() => {
    useSidebarStore.setState({
      cwd: CWD,
      levels: { "": [{ name: "frontend", path: "frontend", type: "dir" }] },
      loading: {},
      truncated: {},
      errors: {},
      hidden: true,
    });
  });

  it("点刷新不会把已展开的目录折回去", async () => {
    render(<FilesPanel cwd={CWD} active />);

    // 展开 frontend：子项 src 出现。
    fireEvent.click(screen.getByText("frontend"));
    expect(await screen.findByText("src")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("刷新文件树"));
    // 刷新会重取根目录与已展开的 frontend；重取期间树不能闪成空白，
    // 之后 src 仍在（TreeNode 没被卸载重挂，展开状态保留）。
    expect(screen.getByText("src")).toBeTruthy();
    await waitFor(() => expect(useSidebarStore.getState().loading[""]).toBe(false));
    await waitFor(() => expect(useSidebarStore.getState().loading.frontend).toBe(false));
    expect(screen.getByText("frontend")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
  });
});

describe("正文图片的「在右侧栏打开」", () => {
  beforeEach(() => {
    seed();
    useSidebarStore.setState({
      openRequest: null,
      readFile: async (path: string) => ({ path, size: 3, binary: false, truncated: false, content: "hi" }),
    });
  });

  it("透传的路径直接进该文件的预览", async () => {
    // 树里没有这个文件也能打开：readFile 走独立请求，不依赖展开过的目录
    render(<FilesPanel cwd={CWD} active pending={{ path: "probe/quad.png", seq: 1 }} />);
    expect(await screen.findByText("quad.png")).toBeTruthy();
  });

  it("同一个路径点第二次仍会重新请求（靠 seq 递增）", async () => {
    const seen: string[] = [];
    useSidebarStore.setState({
      readFile: async (path: string) => {
        seen.push(path);
        return { path, size: 3, binary: false, truncated: false, content: "hi" };
      },
    });
    const { rerender } = render(
      <FilesPanel cwd={CWD} active pending={{ path: "probe/quad.png", seq: 1 }} />,
    );
    await waitFor(() => expect(seen).toHaveLength(1));
    rerender(<FilesPanel cwd={CWD} active pending={{ path: "probe/quad.png", seq: 2 }} />);
    await waitFor(() => expect(seen).toHaveLength(2));
  });

  // 回归：侧栏是「先开标签、面板才挂载」的，挂载那一刻 store 里的 cwd 可能还没落定。
  // 之前把请求记在 seq 上就消费，readFile 抛「未选择工作区」，这次点击就白丢了。
  it("cwd 未就绪时不消费请求，等 cwd 到位再打开", async () => {
    const seen: string[] = [];
    useSidebarStore.setState({
      readFile: async (path: string) => {
        seen.push(path);
        return { path, size: 3, binary: false, truncated: false, content: "hi" };
      },
    });
    const { rerender } = render(
      <FilesPanel cwd="" active pending={{ path: "probe/quad.png", seq: 1 }} />,
    );
    expect(seen).toHaveLength(0);
    rerender(<FilesPanel cwd={CWD} active pending={{ path: "probe/quad.png", seq: 1 }} />);
    await waitFor(() => expect(seen).toHaveLength(1));
  });
});

describe("文件预览的缩放", () => {
  beforeEach(() => {
    seed();
    useSidebarStore.setState({
      openRequest: null,
      readFile: async (path: string) => ({
        path,
        size: 3,
        // 图片一律按二进制回来（后端 raw 走的是另一条路），这里只关心预览分支
        binary: path.endsWith(".png"),
        truncated: false,
        content: "# hi",
      }),
    });
  });

  it("图片预览底部有缩放条", async () => {
    render(<FilesPanel cwd={CWD} active pending={{ path: "probe/quad.png", seq: 1 }} />);
    expect(await screen.findByText("100%")).toBeTruthy();
    expect(screen.getByRole("button", { name: /放大|Zoom in/ })).toBeTruthy();
  });

  it("markdown / 文本预览没有缩放条", async () => {
    render(<FilesPanel cwd={CWD} active pending={{ path: "README.md", seq: 1 }} />);
    // 树里也有 README.md，等预览区显示出来再断言（md 默认是源码视图）
    expect(await screen.findByText("# hi")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });
});

describe("可渲染文件的视图切换", () => {
  const readAs = (path: string, content: string) => async () => ({
    path,
    size: content.length,
    binary: false,
    truncated: false,
    content,
  });

  beforeEach(() => {
    seed();
    useSidebarStore.setState({ openRequest: null });
  });

  it("markdown 默认看源码，点按钮渲染，再点回源码", async () => {
    useSidebarStore.setState({ readFile: readAs("README.md", "# hi") });
    render(<FilesPanel cwd={CWD} active pending={{ path: "README.md", seq: 1 }} />);

    // 默认源码：先看文件本身写了什么，渲染是显式的第二下。
    expect(await screen.findByText("# hi")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "hi" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看渲染效果" }));
    expect(screen.getByRole("heading", { name: "hi" })).toBeTruthy();
    expect(screen.queryByText("# hi")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByText("# hi")).toBeTruthy();
  });

  it("html 默认看源码，点按钮在沙箱 iframe 里渲染", async () => {
    useSidebarStore.setState({ readFile: readAs("index.html", "<h1>hello</h1>") });
    render(<FilesPanel cwd={CWD} active pending={{ path: "index.html", seq: 1 }} />);

    // 默认源码：与改动前一致，不会一打开就跑工作区里的页面。
    expect(await screen.findByText("<h1>hello</h1>")).toBeTruthy();
    expect(document.querySelector("iframe[title='index.html']")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看渲染效果" }));
    const frame = document.querySelector("iframe[title='index.html']") as HTMLIFrameElement | null;
    expect(frame).toBeTruthy();
    // 沙箱必须一个字都不开：脚本与 allow-same-origin 都不给，页面读不到本地令牌。
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain("<h1>hello</h1>");
  });

  it("不可渲染的类型没有切换按钮", async () => {
    useSidebarStore.setState({ readFile: readAs("main.go", "package main") });
    render(<FilesPanel cwd={CWD} active pending={{ path: "main.go", seq: 1 }} />);

    expect(await screen.findByText("package main")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /查看源码|查看渲染效果/ })).toBeNull();
  });
});

describe("文件页顶部路径与搜索", () => {
  it("顶部显示完整工作区路径，宽度不够时由 CSS 从开头省略", () => {
    render(<FilesPanel cwd={CWD} active />);
    const path = screen.getByTitle(CWD);
    expect(path).toHaveTextContent(CWD);
    expect(path.className).toContain("path-start-ellipsis");
  });

  it("搜索按名字找文件，结果行给出相对目录", async () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("搜索工作区文件"));
    const input = screen.getByRole("textbox", { name: "搜索工作区文件" });
    fireEvent.change(input, { target: { value: "read" } });

    // 防抖 300ms 之后才发请求；树在有关键词时让位给结果列表。
    const hit = await screen.findByTitle("README.md");
    expect(hit).toHaveTextContent("README.md");
    expect(screen.queryByText("目录为空")).toBeNull();
    const urls = apiFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/fs/search") && u.includes("q=read"))).toBe(true);
  });

  it("没有匹配时给一句空状态", async () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("搜索工作区文件"));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索工作区文件" }), { target: { value: "zzz" } });
    expect(await screen.findByText("没有匹配的文件。")).toBeInTheDocument();
  });

  it("点目录结果回到树里并展开它", async () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("搜索工作区文件"));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索工作区文件" }), { target: { value: "read" } });
    fireEvent.click(await screen.findByTitle("src"));

    // 查询被清空、结果列表让位给树；命中的目录开始加载自己的子项。
    await waitFor(() => expect(screen.getByRole("textbox", { name: "搜索工作区文件" })).toHaveValue(""));
    await waitFor(() => {
      const urls = apiFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/api/fs/tree") && u.includes("path=src"))).toBe(true);
    });
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("Escape 清空并收起搜索", () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("搜索工作区文件"));
    const input = screen.getByRole("textbox", { name: "搜索工作区文件" });
    fireEvent.change(input, { target: { value: "read" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "搜索工作区文件" })).toBeNull();
    expect(screen.getByLabelText("搜索工作区文件")).toBeInTheDocument();
  });
});
