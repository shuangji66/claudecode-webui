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
  // `/api/conversations` 的响应：默认只有那条有内容的旧对话。要观察「跨工作区收空壳」
  // 时得把空壳也放进去——只在 setState 里给它不够，`refreshConversations` 会立刻用
  // 这里的响应把列表盖回去。
  list: null as null | unknown[],
}));

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      h.calls.push(path);
      if (path.startsWith("/api/sessions")) return { sessions: [created] };
      if (path.startsWith("/api/conversations")) return { conversations: h.list ?? [conv] };
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
  h.list = null;
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

describe("createSession：每个工作区只留一条空对话", () => {
  beforeEach(reset);

  // 从一条**有内容**的对话上点「新对话」/ 工作区行尾的「+」：工作区里已经有空壳就进去，
  // 不能每点一次就多堆一条同名「新对话」（截图复现过），那还各占一个常驻会话槽位。
  it("工作区里已有空对话时直接进去，不再新建", async () => {
    const openConversation = vi.fn(async () => true);
    useAppStore.setState({
      activeId: "c1",
      conversations: [conv, { id: "c0", cwd: "/w", title: "", messages: 0, archived: false, live: false }] as never,
      openConversation: openConversation as never,
    });

    await useAppStore.getState().createSession();

    expect(openConversation).toHaveBeenCalledWith("c0");
    // 一条 POST /api/session 都没发：没有起新进程。
    expect(h.calls.filter((p) => p === "/api/session")).toHaveLength(0);
    // 与新建路径同一条规矩：等后端的这几秒先把「新对话页」摆出来（activeId 为空）。
    // 这里 openConversation 是桩，不会自己 setActive，所以停在空态是正确的观察点。
    expect(useAppStore.getState().activeId).toBeNull();
  });

  // 别的工作区的空对话不能被复用：那会把新对话建到另一个目录里。
  it("别的工作区的空对话不算", async () => {
    useAppStore.setState({
      activeId: "c1",
      conversations: [conv, { id: "c9", cwd: "/other", title: "", messages: 0, archived: false, live: false }] as never,
    });
    const p = useAppStore.getState().createSession();
    h.release?.();
    await p;
    expect(useAppStore.getState().activeId).toBe("c2");
  });
});

describe("createSession：跨工作区时收掉被留下的空壳", () => {
  beforeEach(reset);

  // 「每个工作区一条空对话」只在同一目录内兜住。从 A 的空对话切到 B 再新建，
  // A 那条空壳既没转录、也不在眼前，不收掉就一直占一个常驻会话槽位。
  it("原来那条是空壳就关掉它", async () => {
    const closeSession = vi.fn(async () => {});
    const shell = { id: "c1", cwd: "/w", title: "", messages: 0, archived: false, live: true };
    h.list = [shell];
    useAppStore.setState({
      activeId: "c1",
      conversations: [shell] as never,
      closeSession: closeSession as never,
    });
    const p = useAppStore.getState().createSession("/other");
    h.release?.();
    await p;
    expect(closeSession).toHaveBeenCalledWith("c1");
  });

  // 反过来这一侧更要命：有内容的对话永远不能被顺手关掉。
  it("原来那条有内容就不动它", async () => {
    const closeSession = vi.fn(async () => {});
    useAppStore.setState({ activeId: "c1", closeSession: closeSession as never });
    const p = useAppStore.getState().createSession("/other");
    h.release?.();
    await p;
    expect(closeSession).not.toHaveBeenCalled();
  });

  // `isNewChat(undefined, 0)` 是 true（「刚创建、还没落元数据」）。列表里查不到这个
  // id 时若照它判，就会把一条有内容的对话关掉——必须先确认 prev 存在。
  it("上一条不在列表里时不误关", async () => {
    const closeSession = vi.fn(async () => {});
    useAppStore.setState({
      activeId: "gone",
      conversations: [] as never,
      items: { gone: [{ id: "u1", seq: 1, ts: 1, kind: "user", text: "有内容" }] } as never,
      closeSession: closeSession as never,
    });
    const p = useAppStore.getState().createSession("/other");
    h.release?.();
    await p;
    expect(closeSession).not.toHaveBeenCalled();
  });
});
