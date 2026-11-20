import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitPanel } from "./GitPanel";
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
      if (url.pathname.endsWith("/api/git/diff")) return { diff };
      if (url.pathname.endsWith("/api/git/file")) return { content: "const a = 2;\n" };
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
  useSidebarStore.setState({
    cwd: CWD,
    repo: "",
    repos: [],
    git: {
      is_repo: true,
      branch: "master",
      entries: [{ path: "src/a.ts", xy: " M" }],
    },
    gitLoading: false,
    gitError: "",
    branches: { current: "master", names: ["master"] },
    log: [],
    logError: "",
    actionError: "",
  });
}

beforeEach(() => {
  seed();
  apiFetch.mockClear();
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
