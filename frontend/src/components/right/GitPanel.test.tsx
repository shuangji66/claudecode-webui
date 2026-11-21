import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GitPanel, commitBody } from "./GitPanel";
import { useSidebarStore } from "../../store/useSidebarStore";

const { apiFetch } = vi.hoisted(() => {
  // 状态里放一个未暂存文件、一个已暂存文件与一个未跟踪文件，diff 一律回同一段补丁。
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
  ].join("\n");
  const commitDiff = [
    "diff --git a/src/one.ts b/src/one.ts",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1 +1 @@",
    "-old one",
    "+new one",
    "diff --git a/src/two.ts b/src/two.ts",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -1 +1 @@",
    "-old two",
    "+new two",
    "diff --git a/src/one.test.ts b/src/one.test.ts",
    "--- a/src/one.test.ts",
    "+++ b/src/one.test.ts",
    "@@ -1 +1 @@",
    "-old test",
    "+new test",
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");
  const entries = [
    { path: "src/a.ts", xy: " M", unstaged: { additions: 1, deletions: 1 } },
    { path: "src/b.ts", xy: "M ", staged: { additions: 2, deletions: 0 } },
    { path: "src/new.ts", xy: "??" },
  ];
  return {
    apiFetch: vi.fn(async (path: string): Promise<unknown> => {
      const url = new URL(path, "http://localhost");
      if (url.pathname.endsWith("/api/git/status")) {
        return { is_repo: true, branch: "master", entries };
      }
      if (url.pathname.endsWith("/api/git/branches")) return { current: "master", names: ["master"] };
      if (url.pathname.endsWith("/api/git/diff")) return { diff };
      if (url.pathname.endsWith("/api/git/file")) return { content: "const a = 2;\n" };
      if (url.pathname.endsWith("/api/git/log")) {
        return {
          entries: [
            {
              hash: "abc1234",
              hash_full: "abc1234def5678",
              parents: ["ppp0000"],
              subject: "标题行",
              author: "ccweb dev",
              date: "2026-11-19T16:08:57+08:00",
              refs: "",
            },
          ],
        };
      }
      if (url.pathname.endsWith("/api/git/show")) {
        return {
          hash: "abc1234",
          hash_full: "abc1234def5678",
          parents: ["ppp0000"],
          subject: "标题行",
          author: "ccweb dev",
          author_email: "dev@example.com",
          date: "2026-11-19T16:08:57+08:00",
          refs: "",
          message: "标题行\n\n这是提交正文。",
          diff: commitDiff,
        };
      }
      return {};
    }),
  };
});

vi.mock("../../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/runtime")>();
  return { ...actual, apiFetch };
});

const CWD = "/vol1/1000/demo";

function seed() {
  // Git 状态现在由每个面板自己的 useGitRepo 拉（分栏后两栏可以各看一个仓库），
  // 这里只放共享的工作区与仓库列表。
  useSidebarStore.setState({ cwd: CWD, repos: [], cwdRepo: "" });
}

beforeEach(() => {
  seed();
  apiFetch.mockClear();
});

describe("移动端底部安全区", () => {
  // 移动端右侧栏是全屏抽屉：面板底边就是屏幕底边，最下面压着分支胶囊那一行。
  // 不留安全区，iPhone 的 Home Indicator 会横在上面。jsdom 不算 env()，钉类名。
  it("整列留出安全区，覆盖变更 / 历史 / diff / 提交详情四条渲染路径", async () => {
    render(<GitPanel cwd={CWD} active />);
    const root = (await screen.findByLabelText("暂存 src/a.ts")).closest("div.flex.h-full.min-h-0.flex-col") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain("pb-[calc(env(safe-area-inset-bottom,0px)+8px)]");

    // 专注 diff 时仍是这一个根节点（留白在列上，不在列表分支里）。
    fireEvent.click(screen.getByTitle("src/a.ts"));
    await screen.findByText("const a = 2;");
    expect(screen.getByLabelText(/自动换行/).closest("div.flex.h-full.min-h-0.flex-col")).toBe(root);
  });
});

describe("GitPanel 差异预览", () => {
  it("只预览，不摆任何暂存/取消暂存按钮（已暂存的文件也一样）", async () => {
    render(<GitPanel cwd={CWD} active />);

    // 暂存的入口在变更列表的行内操作上，预览里不重复一遍。
    expect(await screen.findByLabelText("暂存 src/a.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("src/a.ts"));
    await screen.findByText("const a = 2;");
    expect(screen.queryByRole("button", { name: /暂存/ })).toBeNull();

    // 已暂存的文件：预览顶上同样不该冒出一颗「取消暂存」。
    fireEvent.click(screen.getByLabelText("返回"));
    fireEvent.click(await screen.findByTitle("src/b.ts"));
    await screen.findByText("const a = 2;");
    expect(screen.getByRole("button", { name: "关闭自动换行" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /暂存/ })).toBeNull();
  });

  it("未跟踪文件也不摆「暂存」按钮", async () => {
    render(<GitPanel cwd={CWD} active />);
    fireEvent.click(await screen.findByTitle("src/new.ts"));

    await waitFor(() => expect(screen.getByLabelText(/自动换行/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /暂存/ })).toBeNull();
  });

  it("差异默认自动换行，右上角的按钮可以关掉", async () => {
    render(<GitPanel cwd={CWD} active />);
    fireEvent.click(await screen.findByTitle("src/a.ts"));

    // 默认折行：代码行不再 `whitespace-pre`，容器也不按最长行撑开。
    await screen.findByText("const a = 2;");
    const toggle = screen.getByRole("button", { name: "关闭自动换行" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("const a = 2;")).toHaveClass("whitespace-pre-wrap");

    fireEvent.click(toggle);
    const next = screen.getByRole("button", { name: "开启自动换行" });
    expect(next).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("const a = 2;")).toHaveClass("whitespace-pre");
    expect(screen.getByText("const a = 2;")).not.toHaveClass("whitespace-pre-wrap");
  });
});

describe("提交详情与差异分页", () => {
  const openCommit = async () => {
    render(<GitPanel cwd={CWD} active />);
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    fireEvent.click(await screen.findByTitle(/abc1234 标题行/));
    await screen.findByText("标题行");
  };

  it("默认落在「提交详情」，显示作者、完整 hash、父提交与正文", async () => {
    await openCommit();

    expect(screen.getByRole("button", { name: "提交详情" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("ccweb dev")).toBeInTheDocument();
    expect(screen.getByText("abc1234def5678")).toBeInTheDocument();
    expect(screen.getByTitle("ppp0000")).toBeInTheDocument();
    // 正文只显示标题之外的部分：`%B` 的首行与 subject 重复，屏幕上「标题行」只出现一次。
    expect(screen.getByText("这是提交正文。")).toBeInTheDocument();
    expect(screen.getAllByText("标题行")).toHaveLength(1);
    // 详情页不该直接铺补丁。
    expect(screen.queryByText("new one")).toBeNull();
  });

  it("正文里重复的标题行不再渲染第二遍", () => {
    expect(commitBody("标题\n\n正文\n", "标题")).toBe("正文");
    // 首行与 subject 不一致（git 折过行）时整份都显示，不静默丢一行。
    expect(commitBody("标题\n正文", "标题 换行了")).toBe("标题\n正文");
  });

  it("切到「差异」按文件分组，可逐个收起", async () => {
    await openCommit();
    fireEvent.click(screen.getByRole("button", { name: /差异/ }));

    // 两个源码文件默认展开。
    const one = screen.getByRole("button", { name: /src\/one\.ts/ });
    expect(one).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("new one")).toBeInTheDocument();
    expect(screen.getByText("new two")).toBeInTheDocument();
    // 二进制文件没有可展开的行，但仍在列表里。
    expect(screen.getByRole("button", { name: /logo\.png/ })).toBeInTheDocument();

    fireEvent.click(one);
    expect(one).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("new one")).toBeNull();
    // 收起一个不影响另一个。
    expect(screen.getByText("new two")).toBeInTheDocument();
  });

  it("测试文件默认折叠，源码文件默认展开", async () => {
    await openCommit();
    fireEvent.click(screen.getByRole("button", { name: /差异/ }));

    // 首屏展开一两屏代码就够了：测试文件按「不影响改动本身」默认收起，
    // 但它在列表里、带增删行数，点一下就能看。
    const test = screen.getByRole("button", { name: /src\/one\.test\.ts/ });
    expect(test).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("new test")).toBeNull();
    expect(screen.getByRole("button", { name: /src\/one\.ts/ })).toHaveAttribute("aria-expanded", "true");
  });
});

// 空仓库（一次提交都没有）：历史面板只能请求一次。
//
// 原来的守卫是 `log.length === 0 && !logLoading`，而空仓库请求回来也是空数组——
// 这个 effect 依赖自己写回的结果，于是永远满足条件，`/api/git/log` 被无限重复请求，
// 面板在空仓库上一直空转。
describe("GitPanel 空仓库的历史", () => {
  it("只请求一次 /api/git/log，并显示空状态", async () => {
    let logCalls = 0;
    apiFetch.mockImplementation(async (path: string): Promise<unknown> => {
      const url = new URL(path, "http://localhost");
      if (url.pathname.endsWith("/api/git/status")) return { is_repo: true, branch: "master", entries: [] };
      if (url.pathname.endsWith("/api/git/branches")) return { current: "master", names: ["master"] };
      if (url.pathname.endsWith("/api/git/log")) {
        logCalls += 1;
        return { entries: [] };
      }
      return {};
    });

    render(<GitPanel cwd={CWD} active />);
    fireEvent.click(await screen.findByRole("button", { name: /历史/ }));

    // 给「重复请求」足够的时间暴露出来（若循环存在，这几百毫秒里会请求很多次）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logCalls).toBe(1);
    expect(await screen.findByText("还没有提交。")).toBeInTheDocument();
  });
});

// `busy` 是「有任何 Git 动作在跑」的全局开关：拉取、暂存、切分支都会置真。
// 拿它当提交按钮的文案依据时，点一下右上角那颗同步图标，提交按钮就自己变成
// 「提交中…」——用户根本没提交任何东西。文案只认 `committing`。
describe("GitPanel 拉取不影响提交按钮的文案", () => {
  it("拉取进行中，提交按钮仍然写着「提交」", async () => {
    let releasePull: (() => void) | null = null;
    apiFetch.mockImplementation(async (path: string): Promise<unknown> => {
      const url = new URL(path, "http://localhost");
      if (url.pathname.endsWith("/api/git/status")) {
        return { is_repo: true, branch: "master", upstream: "origin/master", entries: [] };
      }
      if (url.pathname.endsWith("/api/git/branches")) return { current: "master", names: ["master"] };
      if (url.pathname.endsWith("/api/git/log")) return { entries: [] };
      if (url.pathname.endsWith("/api/git/pull")) {
        return new Promise((resolve) => {
          releasePull = () => resolve({ ok: true });
        });
      }
      return {};
    });
    render(<GitPanel cwd={CWD} active />);
    const commitButton = await screen.findByRole("button", { name: "提交" });
    fireEvent.click(screen.getByLabelText("拉取"));

    await waitFor(() => expect(releasePull).not.toBeNull());
    expect(commitButton).toHaveTextContent("提交");
    expect(commitButton).not.toHaveTextContent("提交中…");

    releasePull!();
    await waitFor(() => expect(commitButton).toHaveTextContent("提交"));
  });
});

// 工作区里并排放着多个仓库、或者某个仓库内部又嵌了独立仓库时，chip 是唯一能
// 切过去的入口：重名仓库只显示名字会分不清点的是哪一个，嵌套仓库也要看得出层级。
describe("GitPanel 多仓库 chip", () => {
  it("嵌套仓库带层级标记，重名仓库显示相对路径", async () => {
    apiFetch.mockImplementation(async (path: string): Promise<unknown> => {
      const url = new URL(path, "http://localhost");
      if (url.pathname.endsWith("/api/git/status")) return { is_repo: true, branch: "master", entries: [] };
      if (url.pathname.endsWith("/api/git/branches")) return { current: "master", names: ["master"] };
      if (url.pathname.endsWith("/api/git/log")) return { entries: [] };
      return {};
    });
    useSidebarStore.setState({
      repos: [
        { path: "", name: "work", root: "/w" },
        { path: "a/service", name: "service", root: "/w/a/service", nested: true },
        { path: "b/service", name: "service", root: "/w/b/service", nested: true },
        { path: "beta", name: "beta", root: "/w/beta" },
      ],
      cwdRepo: "",
    });

    render(<GitPanel cwd={CWD} active />);
    // 名字唯一的仓库照旧只显示名字。
    expect(await screen.findByTitle("beta")).toHaveTextContent("beta");
    // 重名的两个改显示相对路径，并标出嵌套层级。
    expect(screen.getByTitle("a/service（嵌套仓库）")).toHaveTextContent("a/service");
    expect(screen.getByTitle("b/service（嵌套仓库）")).toHaveTextContent("b/service");
    expect(screen.getByTitle("工作区根")).toHaveTextContent("work");

    // 点 chip 切仓库：后续状态请求按那个仓库的绝对路径走。
    fireEvent.click(screen.getByTitle("a/service（嵌套仓库）"));
    await waitFor(() => {
      const paths = apiFetch.mock.calls.map((c) => String(c[0]));
      expect(paths.some((p) => p.includes("/api/git/status") && p.includes(encodeURIComponent("/w/a/service")))).toBe(true);
    });
  });
});

describe("GitPanel 分栏后各看各的仓库", () => {
  it("两个面板选中不同仓库，互不跟随", async () => {
    apiFetch.mockImplementation(async (path: string): Promise<unknown> => {
      const url = new URL(path, "http://localhost");
      if (url.pathname.endsWith("/api/git/status")) return { is_repo: true, branch: "master", entries: [] };
      if (url.pathname.endsWith("/api/git/branches")) return { current: "master", names: ["master"] };
      if (url.pathname.endsWith("/api/git/log")) return { entries: [] };
      return {};
    });
    useSidebarStore.setState({
      cwd: "/w",
      cwdRepo: "",
      repos: [
        { path: "", name: "work", root: "/w" },
        { path: "a", name: "a", root: "/w/a" },
        { path: "b", name: "b", root: "/w/b" },
      ],
    });

    const { container } = render(
      <>
        <GitPanel cwd="/w" active />
        <GitPanel cwd="/w" active />
      </>,
    );
    const roots = Array.from(container.querySelectorAll("div.flex.h-full.min-h-0.flex-col")) as HTMLElement[];
    expect(roots).toHaveLength(2);
    const left = within(roots[0]!);
    const right = within(roots[1]!);

    // 两个面板初始都落在工作区根仓库上。
    await waitFor(() => expect(left.getByTitle("工作区根")).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(right.getByTitle("工作区根")).toHaveAttribute("aria-pressed", "true"));

    // 只在左边切到 a：左边请求 /w/a，右边仍然是工作区根。
    fireEvent.click(left.getByTitle("a"));
    await waitFor(() => {
      const paths = apiFetch.mock.calls.map(([path]) => String(path));
      expect(paths.some((p) => p.includes("/api/git/status") && p.includes(encodeURIComponent("/w/a")))).toBe(true);
    });
    expect(left.getByTitle("a")).toHaveAttribute("aria-pressed", "true");
    expect(right.getByTitle("工作区根")).toHaveAttribute("aria-pressed", "true");
    expect(right.getByTitle("a")).toHaveAttribute("aria-pressed", "false");
  });
});
