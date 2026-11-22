// 打开对话时的历史回放：不要用「元数据说没有消息」或「items 非空」当短路。
//
// 另一台设备上开的对话，本机列表可能还是旧的（messages=0 / title 空），而用户点开
// 它时 WS 的几条实时帧又能让 items 立刻非空。两种短路都会让**整段更早的历史**被
// 跳过——界面上只剩进入之后的内容，标题也退回「新对话」（标题是从 items 的首条
// 用户消息推出来的），只有刷新整页才恢复。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, __resetSyncState } from "./useAppStore";

const baseLines = [
  { type: "user", message: { role: "user", content: "旧问题" }, timestamp: "2026-01-01T00:00:00Z" },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "旧回答" }], model: "m" },
    timestamp: "2026-01-01T00:00:05Z",
  },
];
let lines = baseLines;
let transcriptCalls = 0;
let gate: { promise: Promise<void>; resolve: () => void } | null = null;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      if (path.startsWith("/api/history/transcript")) {
        transcriptCalls += 1;
        if (gate) await gate.promise;
        return { id: "c1", cwd: "/w", lines };
      }
      // 会话起不来也无所谓：历史是磁盘上的 jsonl，照样要回放。
      if (path.startsWith("/api/session")) throw new Error("未安装 claude");
      if (path.startsWith("/api/sessions")) return { sessions: [] };
      return {};
    }),
  };
});

function reset(items: Record<string, unknown> = {}) {
  lines = baseLines;
  transcriptCalls = 0;
  gate = null;
  __resetSyncState();
  useAppStore.setState({
    activeId: null,
    conversations: [{ id: "c1", cwd: "/w", title: "", messages: 0 }] as never,
    workspaces: [],
    sessions: [],
    items: items as never,
    error: null,
    starting: false,
  });
}

function kinds() {
  return (useAppStore.getState().items.c1 ?? []).map((i) => i.kind);
}

beforeEach(() => reset());

describe("打开对话必须回放转录", () => {
  it("列表说「没有消息 / 没有标题」也回放（本机列表可能比磁盘旧）", async () => {
    useAppStore.setState({
      conversations: [{ id: "c1", cwd: "/w", title: "", messages: 0 }] as never,
    });
    await useAppStore.getState().openConversation("c1");

    expect(kinds()).toEqual(["user", "assistant"]);
    expect(transcriptCalls).toBe(1);
  });

  it("items 里已经落了实时帧也回放：更早的历史不能被跳过", async () => {
    reset({
      c1: [{ id: "live", seq: 0, ts: Date.now(), kind: "assistant", text: "进入之后才收到的", streaming: false }],
    });
    await useAppStore.getState().openConversation("c1");

    const items = useAppStore.getState().items.c1 ?? [];
    // 转录里那条用户消息回来了，实时帧也还在（合并而不是覆盖）。
    expect(items.some((i) => i.kind === "user" && "text" in i && i.text === "旧问题")).toBe(true);
    expect(items.some((i) => "text" in i && i.text === "进入之后才收到的")).toBe(true);
  });

  it("同一次页面生命周期里第二次进入不再重读转录", async () => {
    await useAppStore.getState().openConversation("c1");
    expect(transcriptCalls).toBe(1);

    await useAppStore.getState().openConversation("c1");
    expect(transcriptCalls).toBe(1);
  });
});

describe("首次连上正在跑的会话：补掉回放与订阅之间的空隙", () => {
  it("重读转录补上之后产生的内容，窗口里到达的实时事件照样落地", async () => {
    await useAppStore.getState().openConversation("c1");
    expect(kinds()).toEqual(["user", "assistant"]);

    // 另一台设备在回放之后又产出了内容（已经写进转录）。
    lines = [
      ...baseLines,
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "回放之后才有的" }], model: "m" },
        timestamp: "2026-01-01T00:00:09Z",
      },
    ];
    gate = deferred();

    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "busy" }, seq: 5, epoch: "e1" },
    });
    // 窗口期间到达的实时事件先压着，不能抢在重读结果前面落地。
    useAppStore.getState().applyEvent("c1", {
      kind: "cli",
      seq: 6,
      data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "窗口内到达的" }] } },
    });
    expect(kinds()).toEqual(["user", "assistant"]);

    gate.resolve();
    await vi.waitFor(() => {
      const texts = (useAppStore.getState().items.c1 ?? []).map((i) => ("text" in i ? i.text : ""));
      expect(texts).toContain("回放之后才有的");
      expect(texts).toContain("窗口内到达的");
    });
  });

  it("空闲的会话不重读（转录已经写完了）", async () => {
    await useAppStore.getState().openConversation("c1");
    expect(transcriptCalls).toBe(1);

    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "ready" }, seq: 5, epoch: "e1" },
    });
    await Promise.resolve();
    expect(transcriptCalls).toBe(1);
  });

  // 窗口里到达的实时帧很可能**已经写进了转录**（CLI 写盘与吐 stdout 只差几毫秒）：
  // 先合并转录、再把缓冲冲进 store 的话，同一条回答会在界面上出现两遍。
  it("窗口里的实时帧已经写进转录时只显示一遍", async () => {
    await useAppStore.getState().openConversation("c1");
    expect(kinds()).toEqual(["user", "assistant"]);

    lines = [
      ...baseLines,
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "两边都有" }], model: "m" },
        // 时间取「现在」：同一条消息的写盘时刻与实时帧到达时刻只差几十毫秒。
        timestamp: new Date().toISOString(),
      },
    ];
    gate = deferred();

    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "busy" }, seq: 5, epoch: "e1" },
    });
    useAppStore.getState().applyEvent("c1", {
      kind: "cli",
      seq: 6,
      data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "两边都有" }] } },
    });
    gate.resolve();
    await vi.waitFor(() => {
      const texts = (useAppStore.getState().items.c1 ?? []).map((i) => ("text" in i ? i.text : ""));
      expect(texts).toContain("两边都有");
    });
    const texts = (useAppStore.getState().items.c1 ?? []).map((i) => ("text" in i ? i.text : ""));
    expect(texts.filter((t) => t === "两边都有")).toHaveLength(1);
  });
});
