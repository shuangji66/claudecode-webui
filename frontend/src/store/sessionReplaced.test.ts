// `/clear` 让 CLI 换了会话 id（session.replaced）之后，本机状态要跟着换。
//
// 场景：用户在对话里发 `/clear`。CLI 新开一份转录，后续轮次全写在另一个 id 下；
// 后端已经把 conversations.json 的记录迁过去了，前端如果还停在旧 id 上，就会出现
// 「界面显示清空前的历史，后端在往新 id 写转录」——两边各走各的，刷新就少一段。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./useAppStore";

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions")) return { sessions: [] };
      if (path.startsWith("/api/conversations")) return { conversations: [] };
      return {};
    }),
  };
});

const { __resetIds } = await import("../lib/normalize");

const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW = "bbbbbbbb-1111-2222-3333-444444444444";

describe("session.replaced（/clear 换 id）", () => {
  beforeEach(() => {
    __resetIds();
    localStorage.clear();
    useAppStore.setState({
      activeId: OLD,
      conversations: [{ id: OLD, cwd: "/w", title: "对话", messages: 3 }] as never,
      workspaces: [],
      sessions: [],
      items: {
        [OLD]: [{ id: "u1", seq: 0, ts: 1, kind: "user", text: "清空前的消息" }],
      },
      usage: { [OLD]: { contextTokens: 1234 } },
      states: { [OLD]: "ready" },
      inits: {},
      modes: {},
      queued: {},
      liveTasks: {},
      doneIds: {},
      subagentItems: {},
      perms: { [OLD]: [{ request_id: "p1" }] as never },
      conns: {},
      error: null,
    });
  });

  it("activeId 与「同一个进程」的状态搬到新 id，被清掉的上下文不搬", () => {
    useAppStore.getState().applyEvent(OLD, { kind: "session.replaced", data: { from: OLD, to: NEW } });
    const s = useAppStore.getState();

    expect(s.activeId).toBe(NEW);
    // 描述进程的：跟着换。
    expect(s.states[NEW]).toBe("ready");
    expect(s.states[OLD]).toBeUndefined();
    // 描述被清掉那段上下文的：不跟过去。新会话从空消息流、空占用开始，
    // 否则界面上会显示「清空前的历史 + 满格上下文」，而 claude 那边是空的。
    expect(s.items[NEW]).toEqual([]);
    expect(s.usage[NEW]).toBeUndefined();
    expect(s.usage[OLD]).toBeUndefined();
    // 旧转录仍在磁盘上（历史记录里还能翻到），只是不再挂在这条活跃对话上。
    expect(s.items[OLD]).toBeUndefined();
    // 挂起的审批属于旧会话，/clear 之后已经作废，不能跟过去。
    expect(s.perms[NEW]).toBeUndefined();
    expect(s.perms[OLD]).toEqual([]);
  });

  it("浏览器里存的 active id 也跟着换（否则刷新会落回旧转录）", () => {
    localStorage.setItem("ccweb-active-session", OLD);
    useAppStore.getState().applyEvent(OLD, { kind: "session.replaced", data: { from: OLD, to: NEW } });
    expect(localStorage.getItem("ccweb-active-session")).toBe(NEW);
  });

  it("看的不是这条对话时，activeId 不动", () => {
    useAppStore.setState({ activeId: "other-id" });
    useAppStore.getState().applyEvent(OLD, { kind: "session.replaced", data: { from: OLD, to: NEW } });
    expect(useAppStore.getState().activeId).toBe("other-id");
    // 但那条对话自己的状态还是要搬：切回去时得在新 id 上。
    expect(useAppStore.getState().states[NEW]).toBe("ready");
  });

  it("新 id 上已经有内容时不覆盖（另一台设备先迁过）", () => {
    useAppStore.setState({
      states: { [OLD]: "ready", [NEW]: "busy" },
      items: { [NEW]: [{ id: "n1", seq: 0, ts: 2, kind: "user", text: "对方设备上的消息" }] },
    });
    useAppStore.getState().applyEvent(OLD, { kind: "session.replaced", data: { from: OLD, to: NEW } });
    const s = useAppStore.getState();
    // 状态机不覆盖对方那份。
    expect(s.states[NEW]).toBe("busy");
    expect(s.states[OLD]).toBeUndefined();
  });

  it("载荷不合法时什么也不做", () => {
    useAppStore.getState().applyEvent(OLD, { kind: "session.replaced", data: {} });
    expect(useAppStore.getState().activeId).toBe(OLD);
    useAppStore.getState().applyEvent(OLD, { kind: "session.replaced", data: { from: OLD, to: OLD } });
    expect(useAppStore.getState().activeId).toBe(OLD);
  });
});
