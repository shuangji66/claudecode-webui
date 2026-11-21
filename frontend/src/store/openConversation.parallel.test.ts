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
