import { beforeEach, describe, expect, it, vi } from "vitest";

// 打开**已停止**的既有对话时，转录不能等 claude 拉起：`POST /api/session`
// 要 spawn 子进程再等 `initialize` 握手，冷启动那几秒里消息区一直是空的
// （界面只剩「正在启动 Claude…」，看起来像对话被弄丢了）。
// 历史是磁盘上的 jsonl，跟进程无关，所以两条请求并行，历史先铺出来。
const transcript = {
  id: "c1",
  cwd: "/w",
  lines: [
    { type: "user", message: { role: "user", content: "旧问题" }, timestamp: "2026-01-01T00:00:00Z" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "旧回答" }], model: "m" },
      timestamp: "2026-01-01T00:00:05Z",
    },
  ],
};

const conv = { id: "c1", cwd: "/w", title: "旧对话", messages: 2 };

// `releaseSession` 让 `/api/session` 停在「claude 正在拉起」的那一刻，
// 用来断言这期间转录已经渲染出来了。
const h = vi.hoisted(() => ({
  calls: [] as string[],
  releaseSession: null as null | (() => void),
}));

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      h.calls.push(path);
      if (path.startsWith("/api/history/transcript")) return transcript;
      if (path.startsWith("/api/sessions")) return { sessions: [] };
      if (path.startsWith("/api/session")) {
        await new Promise<void>((resolve) => {
          h.releaseSession = resolve;
        });
        return { id: "c1", cwd: "/w" };
      }
      if (path.startsWith("/api/conversations")) return { conversations: [conv] };
      return {};
    }),
  };
});

const { useAppStore } = await import("./useAppStore");

describe("openConversation：转录与起会话并行", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.releaseSession = null;
    useAppStore.setState({
      activeId: null,
      conversations: [conv] as never,
      workspaces: [],
      sessions: [],
      items: {},
      error: null,
      starting: false,
      // 不真的开 WS：这条用例只关心「历史什么时候到」。
      connect: (() => undefined) as never,
    });
  });

  it("claude 还没拉起时就已经把转录铺好了", async () => {
    const opening = useAppStore.getState().openConversation("c1");

    // 转录请求在起会话之前就发出去了（不是等 /api/session 回来才发）。
    const iTranscript = h.calls.findIndex((p) => p.startsWith("/api/history/transcript"));
    const iSession = h.calls.findIndex((p) => p === "/api/session");
    expect(iTranscript).toBeGreaterThanOrEqual(0);
    expect(iSession).toBeGreaterThan(iTranscript);

    // 会话那条还挂在一个没 resolve 的 promise 上（= 正在等 initialize 握手）。
    await vi.waitFor(() => {
      expect((useAppStore.getState().items.c1 ?? []).length).toBe(2);
    });
    const mid = useAppStore.getState();
    expect(h.releaseSession).not.toBeNull();
    expect(mid.starting).toBe(true);
    expect((mid.items.c1 ?? []).map((i) => i.kind)).toEqual(["user", "assistant"]);

    h.releaseSession?.();
    await expect(opening).resolves.toBe(true);
    expect((useAppStore.getState().items.c1 ?? []).length).toBe(2);
    expect(useAppStore.getState().starting).toBe(false);
  });
});

describe("openConversation：历史记录页的「先收起」回调", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.releaseSession = null;
    useAppStore.setState({
      activeId: null,
      conversations: [conv] as never,
      workspaces: [],
      sessions: [],
      items: {},
      error: null,
      starting: false,
      connect: (() => undefined) as never,
    });
  });

  it("onHistory 在 claude 拉起之前就触发，且此时历史已经在 items 里", async () => {
    const seen: { items: number; starting: boolean }[] = [];
    const opening = useAppStore.getState().openConversation("c1", false, () => {
      const s = useAppStore.getState();
      seen.push({ items: (s.items.c1 ?? []).length, starting: s.starting });
    });

    await vi.waitFor(() => {
      expect(seen.length).toBe(1);
    });
    // `/api/session` 还挂在握手上：界面已经是「有历史 + 正在启动」，不是空对话。
    expect(h.releaseSession).not.toBeNull();
    expect(seen[0]).toEqual({ items: 2, starting: true });

    h.releaseSession?.();
    await opening;
    expect(seen.length).toBe(1);
  });
});

describe("openConversation：并发与意图序号", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.releaseSession = null;
    useAppStore.setState({
      activeId: null,
      conversations: [conv] as never,
      workspaces: [],
      sessions: [],
      items: {},
      error: null,
      starting: false,
      toast: null,
      connect: (() => undefined) as never,
    });
  });

  // 双击侧栏同一行（或一次点击 + 一次回车）会打进两次 openConversation：
  // 第二次走「已经在起」的分支，它从不写 starting:false，而第一次的 finally
  // 又因为序号变了跳过清理 —— `starting` 就此永久为 true，输入框与「新对话」
  // 一起禁用，只能靠再打开另一条对话自愈。
  it("同一条对话被并发打开时 starting 最终会落回 false", async () => {
    const first = useAppStore.getState().openConversation("c1");
    const second = useAppStore.getState().openConversation("c1");
    await vi.waitFor(() => {
      expect(h.releaseSession).not.toBeNull();
    });
    h.releaseSession?.();
    await Promise.all([first, second]);
    expect(useAppStore.getState().starting).toBe(false);
  });

  // 归档一条正在「拉起中」的对话：迟到的回包不能把它设回 activeId，更不能连上去
  // ——`connect` 之后 `recoverSession` 会按 --resume 把刚结束的进程重新拉起来。
  it("open 期间归档：迟到的回包不再抢回 activeId，也不建连接", async () => {
    const connect = vi.fn();
    useAppStore.setState({ connect: connect as never });

    const opening = useAppStore.getState().openConversation("c1");
    await vi.waitFor(() => {
      expect(h.releaseSession).not.toBeNull();
    });
    await useAppStore.getState().archiveConversation("c1", true);
    expect(useAppStore.getState().activeId).toBeNull();

    h.releaseSession?.();
    await opening;
    expect(useAppStore.getState().activeId).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(useAppStore.getState().starting).toBe(false);
  });

  // 已归档的对话不能从任何入口被打开（store 是兜底闸门，不只是侧栏那两个入口）。
  it("已归档的对话拒绝打开，并给一句轻提示", async () => {
    useAppStore.setState({ conversations: [{ ...conv, archived: true }] as never });
    const before = h.calls.length;
    const ok = await useAppStore.getState().openConversation("c1");
    expect(ok).toBe(false);
    expect(h.calls.length).toBe(before); // 一个请求都不该发
    expect(useAppStore.getState().toast?.text).toContain("已归档");
    expect(useAppStore.getState().starting).toBe(false);
  });
});
