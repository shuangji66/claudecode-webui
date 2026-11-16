import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, apiFetch: vi.fn(async () => ({ conversations: [], sessions: [] })) };
});

const { useAppStore } = await import("./useAppStore");

describe("会话清理", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeId: null,
      conversations: [],
      sessions: [],
      items: {},
      subagentItems: {},
      perms: {},
      states: {},
      inits: {},
      conns: {},
      usage: {},
      doneIds: {},
      error: null,
    });
  });

  it("删除对话后清掉按 id 存的所有桶（否则整份消息与审批会常驻内存）", async () => {
    useAppStore.setState({
      conversations: [{ id: "gone", cwd: "/w", title: "旧对话", messages: 3 }] as never,
      items: { gone: [{ id: "i1", seq: 1, ts: 1, kind: "user", text: "hi" }] } as never,
      subagentItems: { gone: { a1: [] } } as never,
      perms: { gone: [{ request_id: "p1" }] } as never,
      states: { gone: "busy" },
      inits: { gone: { commands: [] } } as never,
      conns: { gone: { state: "open" } } as never,
      usage: { gone: { inputTokens: 1 } } as never,
      doneIds: { gone: true },
    });

    await useAppStore.getState().deleteConversation("gone");

    const s = useAppStore.getState();
    expect(s.items.gone).toBeUndefined();
    expect(s.subagentItems.gone).toBeUndefined();
    expect(s.perms.gone).toBeUndefined();
    expect(s.states.gone).toBeUndefined();
    expect(s.inits.gone).toBeUndefined();
    expect(s.conns.gone).toBeUndefined();
    expect(s.usage.gone).toBeUndefined();
    expect(s.doneIds.gone).toBeUndefined();
  });

  it("结束会话后清空挂起审批并把状态标成 closed", async () => {
    useAppStore.setState({
      perms: { s1: [{ request_id: "p1" }] } as never,
      states: { s1: "busy" },
      conns: { s1: { state: "open" } } as never,
    });

    await useAppStore.getState().closeSession("s1");

    const s = useAppStore.getState();
    expect(s.perms.s1).toEqual([]);
    expect(s.states.s1).toBe("closed");
  });
});
