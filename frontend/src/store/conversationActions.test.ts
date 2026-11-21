// 侧栏会话菜单里「会改状态」的两个动作：归档（回新对话页）与分叉（复制上下文）。
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 记录 apiFetch 的调用；归档只关心 PATCH 是否发出。 */
const calls: Array<{ url: string; init?: RequestInit }> = [];
/** fork 的假回包；测试改它来覆盖「后端没给 id」这条路径。 */
let forkReply: { ok: boolean; id?: string } = { ok: true, id: "c-fork" };
/** 归档 PATCH 的闸门：不 resolve 就等于「请求还在路上」，用来断言乐观更新。 */
let patchGate: Promise<void> | null = null;
/** 归档 PATCH 失败的开关。 */
let patchFails = false;

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/conversations/fork") return forkReply;
      if (url === "/api/conversations" && init?.method === "PATCH") {
        if (patchGate) await patchGate;
        if (patchFails) throw new Error("归档失败：后端不可达");
      }
      return { ok: true };
    }),
  };
});

const { useAppStore } = await import("./useAppStore");

function seed() {
  calls.length = 0;
  forkReply = { ok: true, id: "c-fork" };
  patchGate = null;
  patchFails = false;
  localStorage.clear();
  useAppStore.setState({
    activeId: "c1",
    currentWorkspace: "/w",
    workspaces: [{ path: "/w", name: "w", last_used: "", exists: true }],
    conversations: [
      { id: "c1", cwd: "/w", title: "第一个对话", messages: 2, archived: false, live: false },
      { id: "c2", cwd: "/w", title: "第二个对话", messages: 1, archived: false, live: false },
    ],
    items: {},
    error: null,
    // 真去 openConversation 会建 WS：测试里换成假的，断言它没被调用。
    openConversation: vi.fn(async () => true),
    refreshConversations: vi.fn(async () => {}),
    disconnect: vi.fn(),
  } as never);
}

describe("归档对话", () => {
  beforeEach(() => seed());

  // 参照 DSH：归档掉当前对话就回「新对话」页 —— 那个「下一条」只是按最近活跃猜的，
  // 用户归档完想停下来时却被拉进另一个对话、又起一个 claude 进程。
  it("归档当前对话后回到新对话页，不自动打开下一条", async () => {
    const ok = await useAppStore.getState().archiveConversation("c1", true);

    expect(ok).toBe(true);
    expect(useAppStore.getState().activeId).toBeNull();
    expect(useAppStore.getState().openConversation).not.toHaveBeenCalled();
    expect(useAppStore.getState().disconnect).toHaveBeenCalledWith("c1");
    // 刷新页面后也不能又回到刚被归档的那条。
    expect(localStorage.getItem("ccweb-active-session")).toBeNull();
    expect(JSON.parse(String(calls.find((c) => c.url === "/api/conversations")?.init?.body))).toEqual({
      id: "c1",
      archived: true,
    });
  });

  // 归档后面挂着一次整份列表重建（会把 ~/.claude/projects 下每份转录重扫一遍，
  // NAS 上可到秒级）。等它等于让一次勾选卡住一屏，所以先就地改这一行。
  it("点下去那一行立刻变成已归档，不等请求回包", async () => {
    let release = () => {};
    patchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = useAppStore.getState().archiveConversation("c2", true);

    const row = useAppStore.getState().conversations.find((c) => c.id === "c2");
    expect(row?.archived).toBe(true);
    // 当前对话不是 c2：界面不该跳走。
    expect(useAppStore.getState().activeId).toBe("c1");

    release();
    await expect(p).resolves.toBe(true);
    expect(useAppStore.getState().conversations.find((c) => c.id === "c2")?.archived).toBe(true);
  });

  it("归档失败时把这一行改回来，并回到原来那条对话", async () => {
    patchFails = true;
    const ok = await useAppStore.getState().archiveConversation("c1", true);

    expect(ok).toBe(false);
    const s = useAppStore.getState();
    expect(s.conversations.find((c) => c.id === "c1")?.archived).toBe(false);
    expect(s.activeId).toBe("c1");
    expect(s.error).toContain("归档失败");
  });

  it("归档别的对话不动当前对话", async () => {
    await useAppStore.getState().archiveConversation("c1", true);
    expect(useAppStore.getState().activeId).toBeNull();

    useAppStore.setState({ activeId: "c2" });
    await useAppStore.getState().archiveConversation("c1", false);
    expect(useAppStore.getState().activeId).toBe("c2");
  });
});

describe("分叉会话", () => {
  beforeEach(() => seed());

  // 新 id 由后端生成：前端拿到就打开，标题后缀由调用方给（列表里两条同名没法区分）。
  it("POST /api/conversations/fork 后打开新对话", async () => {
    const ok = await useAppStore.getState().forkConversation("c1", "第一个对话（分叉）");

    expect(ok).toBe(true);
    const call = calls.find((c) => c.url === "/api/conversations/fork");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ id: "c1", title: "第一个对话（分叉）" });
    expect(useAppStore.getState().openConversation).toHaveBeenCalledWith("c-fork");
    expect(useAppStore.getState().refreshConversations).toHaveBeenCalled();
  });

  // 没有新 id 等于分叉没成：不能返回 true 让界面以为开了一条新对话。
  it("后端没返回 id 时算失败并写错误", async () => {
    forkReply = { ok: true };
    const ok = await useAppStore.getState().forkConversation("c1");

    expect(ok).toBe(false);
    expect(useAppStore.getState().openConversation).not.toHaveBeenCalled();
    expect(useAppStore.getState().error).toBeTruthy();
  });

  // 打开新对话失败（cwd 未授权 / 会话起不来）时，fork 的返回值要跟着失败，
  // openConversation 已经写过具体原因，这里只透传。
  it("新对话打不开时返回 false", async () => {
    useAppStore.setState({ openConversation: vi.fn(async () => false) });

    const ok = await useAppStore.getState().forkConversation("c1", "第一个对话（分叉）");

    expect(ok).toBe(false);
  });
});
