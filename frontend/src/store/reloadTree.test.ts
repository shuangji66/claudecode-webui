import { beforeEach, describe, expect, it, vi } from "vitest";

/** 文件树刷新：重取已加载的目录，而不是清空整棵树。
 *
 *  清空会让所有 TreeNode 卸载重挂，本地展开状态归零——用户点一次刷新，
 *  之前展开的目录全折叠回去（回归点）。 */
const apiFetch = vi.fn(async (path: string): Promise<unknown> => {
  if (path.startsWith("/api/fs/tree")) return { entries: [] };
  return {};
});

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, apiFetch };
});

const { useSidebarStore } = await import("./useSidebarStore");

/** 从 /api/fs/tree 的 query 里取出被请求的相对目录。 */
function requestedPaths(): string[] {
  return apiFetch.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith("/api/fs/tree"))
    .map((path) => new URL(path, "http://localhost").searchParams.get("path") ?? "");
}

describe("文件树刷新", () => {
  beforeEach(() => {
    apiFetch.mockClear();
    useSidebarStore.setState({
      cwd: "/ws",
      levels: {
        "": [{ name: "frontend", path: "frontend", type: "dir" }],
        frontend: [{ name: "src", path: "frontend/src", type: "dir" }],
        "frontend/src": [{ name: "main.tsx", path: "frontend/src/main.tsx", type: "file", size: 10 }],
      },
      loading: { "frontend/src": true },
      truncated: { "frontend/src": true },
      errors: { "frontend/nope": "目录不存在" },
      hidden: true,
    });
  });

  it("刷新时不清空已加载的目录（否则展开状态跟着归零）", async () => {
    await useSidebarStore.getState().reloadTree();

    const paths = requestedPaths();
    expect(paths).toContain("");
    expect(paths).toContain("frontend");
    expect(paths).toContain("frontend/src");
    // 关键：不先清空 levels（旧树始终在，节点不会卸载重挂）。
    expect(useSidebarStore.getState().levels["frontend/src"]).toBeDefined();
  });

  it("读取失败过的目录清掉错误，挂着的节点会自己重取", async () => {
    await useSidebarStore.getState().reloadTree();

    // 没加载成功的目录不在 levels 里，刷新时不必主动请求；清掉 error 之后
    // 节点的 effect（children===undefined && !error）会补一次。
    expect(useSidebarStore.getState().errors["frontend/nope"]).toBeUndefined();
  });

  it("残留的 loading 不会挡住强制重取", async () => {
    await useSidebarStore.getState().reloadTree();

    // 上一轮（旧 treeEpoch）还挂在 loading 上的路径，刷新后照样发请求。
    expect(requestedPaths()).toContain("frontend/src");
    expect(useSidebarStore.getState().loading["frontend/src"]).toBe(false);
  });
});
