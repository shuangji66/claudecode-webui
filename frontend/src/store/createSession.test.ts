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

describe("createSession：跨工作区的空壳", () => {
  beforeEach(reset);

  // 会话全局唯一：A 里有内容对话、B 里躺着一条空壳时，在 A 点「新对话」不能
  // 复用 B 的空壳（claude 会跑到 B 去），但也不能把这个空壳留在那儿占槽位。
  // 正确做法：在 A 新建，再把 B 那条收掉。
  it("别的工作区有空壳：在目标目录新建，并收掉那个空壳", async () => {
    const closeSession = vi.fn(async () => {});
    const shell = { id: "s1", cwd: "/b", title: "", messages: 0, archived: false, live: true };
    h.list = [conv, shell];
    useAppStore.setState({
      activeId: "c1",
      conversations: [conv, shell] as never,
      closeSession: closeSession as never,
    });

    const p = useAppStore.getState().createSession("/w");
    h.release?.();
    await p;

    // 新建走的是目标目录，不是把 /b 那条复用过来。
    expect(h.calls.filter((x) => x === "/api/session")).toHaveLength(1);
    expect(useAppStore.getState().activeId).toBe("c2");
    expect(closeSession).toHaveBeenCalledWith("s1");
  });

  // 反过来这一侧更要命：有内容的对话永远不能被顺手关掉。
  it("别的工作区那条有内容就不动它", async () => {
    const closeSession = vi.fn(async () => {});
    const other = { id: "o1", cwd: "/b", title: "旧对话", messages: 5, archived: false, live: true };
    h.list = [conv, other];
    useAppStore.setState({
      activeId: "c1",
      conversations: [conv, other] as never,
      closeSession: closeSession as never,
    });

    const p = useAppStore.getState().createSession("/w");
    h.release?.();
    await p;

    expect(closeSession).not.toHaveBeenCalled();
  });

  // 新建失败时不能收：用户会被回滚到原来那条，而那条已经被关掉就是错的。
  it("新建失败时不收空壳", async () => {
    const closeSession = vi.fn(async () => {});
    const shell = { id: "s1", cwd: "/b", title: "", messages: 0, archived: false, live: true };
    h.list = [shell];
    useAppStore.setState({
      activeId: "c1",
      conversations: [shell] as never,
      closeSession: closeSession as never,
    });
    h.fail = true;

    const p = useAppStore.getState().createSession("/w");
    h.release?.();
    await p;

    expect(closeSession).not.toHaveBeenCalled();
    // 回滚到点「新对话」之前那条。
    expect(useAppStore.getState().activeId).toBe("c1");
  });

  // 本工作区那条是「进去」而不是新建，进去之后同样把别处的空壳收掉。
  it("复用本工作区的空壳后，也收掉别处的", async () => {
    const closeSession = vi.fn(async () => {});
    const openConversation = vi.fn(async () => true);
    const here = { id: "h1", cwd: "/w", title: "", messages: 0, archived: false, live: true };
    const there = { id: "t1", cwd: "/b", title: "", messages: 0, archived: false, live: true };
    h.list = [here, there];
    useAppStore.setState({
      activeId: "c1",
      conversations: [here, there] as never,
      openConversation: openConversation as never,
      closeSession: closeSession as never,
    });

    await useAppStore.getState().createSession("/w");

    expect(openConversation).toHaveBeenCalledWith("h1");
    expect(h.calls.filter((x) => x === "/api/session")).toHaveLength(0);
    expect(closeSession).toHaveBeenCalledWith("t1");
    // 复用的那条不能被自己收掉。
    expect(closeSession).not.toHaveBeenCalledWith("h1");
  });
});
