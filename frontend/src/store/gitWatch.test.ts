import { beforeEach, describe, expect, it, vi } from "vitest";

/** 右侧栏 Store 的 Git 推送路径：状态 / 分支 / 历史由一次 git.changed 一起刷新。 */
const apiFetch = vi.fn(async (path: string): Promise<unknown> => {
  if (path.startsWith("/api/git/status")) return { is_repo: true, branch: "main", entries: [] };
  if (path.startsWith("/api/git/branches")) return { current: "main", names: ["main"] };
  if (path.startsWith("/api/git/log")) return { entries: [{ hash: "abc1234", subject: "init" }] };
  return {};
});

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, apiFetch };
});

const { useSidebarStore } = await import("./useSidebarStore");

function calls(prefix: string): number {
  return apiFetch.mock.calls.filter(([path]) => String(path).startsWith(prefix)).length;
}

describe("Git 推送（系统通道的 git.changed）", () => {
  beforeEach(() => {
    apiFetch.mockClear();
    useSidebarStore.setState({ cwd: "/ws", repo: "/ws/repo", git: null, branches: null, log: [], logError: "", gitError: "" });
  });

  it("刷新状态、分支与历史", async () => {
    await useSidebarStore.getState().gitChanged("/ws/repo");

    expect(calls("/api/git/status")).toBe(1);
    expect(calls("/api/git/branches")).toBe(1);
    expect(calls("/api/git/log")).toBe(1);
    expect(useSidebarStore.getState().git?.branch).toBe("main");
    expect(useSidebarStore.getState().log).toHaveLength(1);
  });

  it("事件里的 cwd 不是当前仓库时整条丢掉（换仓库时旧推送可能还在路上）", async () => {
    await useSidebarStore.getState().gitChanged("/ws/other");

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("状态已经不是仓库时不再拉分支与历史（那两条只会各报一次错）", async () => {
    apiFetch.mockImplementationOnce(async () => ({ is_repo: false, entries: [] }));

    await useSidebarStore.getState().gitChanged("/ws/repo");

    expect(calls("/api/git/branches")).toBe(0);
    expect(calls("/api/git/log")).toBe(0);
  });

  it("并发的两次推送共用同一条 git log", async () => {
    let release: (() => void) | null = null;
    apiFetch.mockImplementation(async (path: string): Promise<unknown> => {
      if (path.startsWith("/api/git/status")) return { is_repo: true, branch: "main", entries: [] };
      if (path.startsWith("/api/git/branches")) return { current: "main", names: ["main"] };
      if (path.startsWith("/api/git/log")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { entries: [] };
      }
      return {};
    });

    const first = useSidebarStore.getState().gitChanged("/ws/repo");
    const second = useSidebarStore.getState().gitChanged("/ws/repo");
    // 等两条链路都走到「正在拉历史」这一步，再放行。
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await Promise.all([first, second]);

    expect(calls("/api/git/log")).toBe(1);
  });
});
