import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

/** Git 面板的推送路径：一次 git.changed 刷新状态 / 分支 / 历史（按面板各自的仓库）。 */
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

const { useGitRepo } = await import("./useGitRepo");
const { notifyGitChanged } = await import("./useAppStore");
const { useSidebarStore } = await import("./useSidebarStore");

function calls(prefix: string): number {
  return apiFetch.mock.calls.filter(([path]) => String(path).startsWith(prefix)).length;
}

async function mountRepo() {
  const { result } = renderHook(() => useGitRepo("/ws", true));
  await waitFor(() => expect(result.current.repo).toBe("/ws/repo"));
  await waitFor(() => expect(result.current.git?.is_repo).toBe(true));
  apiFetch.mockClear();
  return result;
}

describe("Git 推送（系统通道的 git.changed）", () => {
  beforeEach(() => {
    apiFetch.mockClear();
    apiFetch.mockImplementation(async (path: string): Promise<unknown> => {
      if (path.startsWith("/api/git/status")) return { is_repo: true, branch: "main", entries: [] };
      if (path.startsWith("/api/git/branches")) return { current: "main", names: ["main"] };
      if (path.startsWith("/api/git/log")) return { entries: [{ hash: "abc1234", subject: "init" }] };
      return {};
    });
    useSidebarStore.setState({
      cwd: "/ws",
      repos: [{ path: "repo", name: "repo", root: "/ws/repo" }],
      cwdRepo: "/ws/repo",
    });
  });

  it("刷新状态、分支与历史", async () => {
    const result = await mountRepo();

    notifyGitChanged("/ws/repo");

    await waitFor(() => expect(calls("/api/git/status")).toBe(1));
    await waitFor(() => expect(calls("/api/git/branches")).toBe(1));
    await waitFor(() => expect(calls("/api/git/log")).toBe(1));
    await waitFor(() => expect(result.current.log).toHaveLength(1));
  });

  it("事件里的 cwd 不是当前仓库时整条丢掉（另一栏的仓库与这边无关）", async () => {
    await mountRepo();

    notifyGitChanged("/ws/other");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("状态已经不是仓库时不再拉分支与历史（那两条只会各报一次错）", async () => {
    await mountRepo();
    apiFetch.mockImplementationOnce(async () => ({ is_repo: false, entries: [] }));

    notifyGitChanged("/ws/repo");

    await waitFor(() => expect(calls("/api/git/status")).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls("/api/git/branches")).toBe(0);
    expect(calls("/api/git/log")).toBe(0);
  });


  it("两个面板实例各自选仓库，互不跟随", async () => {
    useSidebarStore.setState({
      cwd: "/ws",
      cwdRepo: "",
      repos: [
        { path: "a", name: "a", root: "/ws/a" },
        { path: "b", name: "b", root: "/ws/b" },
      ],
    });
    const one = renderHook(() => useGitRepo("/ws", true));
    const two = renderHook(() => useGitRepo("/ws", true));

    await waitFor(() => expect(one.result.current.repo).toBe("/ws/a"));
    await waitFor(() => expect(two.result.current.repo).toBe("/ws/a"));

    act(() => one.result.current.selectRepo("/ws/b"));

    await waitFor(() => expect(one.result.current.repo).toBe("/ws/b"));
    expect(two.result.current.repo).toBe("/ws/a");
    await waitFor(() => {
      const paths = apiFetch.mock.calls.map(([path]) => String(path));
      expect(paths.some((p) => p.includes("/api/git/status") && p.includes("cwd=%2Fws%2Fb"))).toBe(true);
    });
  });

  it("并发的两次推送共用同一条 git log", async () => {
    await mountRepo();
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

    notifyGitChanged("/ws/repo");
    notifyGitChanged("/ws/repo");
    await waitFor(() => expect(release).not.toBeNull());
    release!();
    await waitFor(() => expect(calls("/api/git/log")).toBe(1));
  });
});
