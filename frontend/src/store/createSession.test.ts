import { beforeEach, describe, expect, it, vi } from "vitest";

// 点「新对话」时，`POST /api/session` 要 spawn 子进程再等 initialize 握手（冷启动几秒）。
// 这期间界面不能还停在旧对话上：先把「新对话页」摆出来（activeId 置空 = 还没开始的
// 新对话），id 到手后再切到那个空对话——两者布局完全一样，所以不会闪。
const conv = { id: "c1", cwd: "/w", title: "旧对话", messages: 2 };
const created = { id: "c2", cwd: "/w", state: "idle" };

const h = vi.hoisted(() => ({
  calls: [] as string[],
  release: null as null | (() => void),
  fail: false,
}));

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      h.calls.push(path);
      if (path.startsWith("/api/sessions")) return { sessions: [created] };
      if (path.startsWith("/api/conversations")) return { conversations: [conv] };
      if (path === "/api/session") {
        await new Promise<void>((resolve) => {
          h.release = resolve;
        });
        if (h.fail) throw new Error("manager: claudebin: 未安装 claude");
        return created;
      }
      return {};
    }),
  };
});

const { useAppStore } = await import("./useAppStore");

function reset() {
  h.calls.length = 0;
  h.release = null;
  h.fail = false;
  useAppStore.setState({
    activeId: "c1",
    conversations: [conv] as never,
    workspaces: [{ path: "/w", name: "w", created_at: "2026-01-01T00:00:00Z" }],
    currentWorkspace: "/w",
    sessions: [{ id: "c1", cwd: "/w", state: "idle" }] as never,
    items: {},
    error: null,
    starting: false,
    // 不真的开 WS：这条用例只关心「页面什么时候切过去」。
    connect: (() => undefined) as never,
  } as never);
}

describe("createSession：先把新对话页摆出来", () => {
  beforeEach(reset);

  it("activeId 立刻清空（= 新对话页），id 到手后才切到新会话", async () => {
    const p = useAppStore.getState().createSession();

    // 同步：还没等后端回包，界面已经是「还没开始的新对话」。
    expect(useAppStore.getState().activeId).toBeNull();
    expect(useAppStore.getState().starting).toBe(true);
    expect(h.release).not.toBeNull();

    h.release?.();
    await p;
    expect(useAppStore.getState().activeId).toBe("c2");
    expect(useAppStore.getState().starting).toBe(false);
  });

  it("起不来就回到原来那条对话，并把原因报出来", async () => {
    h.fail = true;
    const p = useAppStore.getState().createSession();
    h.release?.();
    await p;
    const s = useAppStore.getState();
    // 不能把用户留在一个空的「新对话」页上（原来那段对话被藏起来了）。
    expect(s.activeId).toBe("c1");
    expect(s.error).toContain("未安装 claude");
  });
});
