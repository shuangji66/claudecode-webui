// 断线重连后的消息流补齐（会话事件的 seq 水位 + sync + session.replay/resync）。
//
// 场景：WS 断开期间 claude 把这一轮跑完了（正文、工具结果、结束时的 result 全在
// 断线期间产生）。重连后只拿到一份 session.snapshot，消息流是空的——没有这套机制
// 就会永久缺一段、用量与速度也丢了，只有刷新整页（整份转录回放）才恢复。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./useAppStore";

const transcriptCalls: string[] = [];
const transcript = {
  id: "c1",
  cwd: "/w",
  lines: [
    { type: "user", message: { role: "user", content: "跑一遍测试" }, timestamp: "2026-01-01T00:00:00Z" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "断线期间跑完了" }], model: "m" },
      timestamp: "2026-01-01T00:00:05Z",
    },
    {
      type: "result",
      timestamp: "2026-01-01T00:00:06Z",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      duration_ms: 6000,
    },
  ],
};

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      if (path.startsWith("/api/history/transcript")) {
        transcriptCalls.push(path);
        return transcript;
      }
      if (path.startsWith("/api/sessions")) return { sessions: [{ id: "c1", cwd: "/w", state: "ready" }] };
      return {};
    }),
  };
});

const { __resetIds } = await import("../lib/normalize");
const { __resetSyncState } = await import("./useAppStore");

function assistantLine(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("重连补齐", () => {
  beforeEach(() => {
    __resetIds();
    __resetSyncState();
    transcriptCalls.length = 0;
    // 每个用例都从干净状态起：模块级的水位是按会话 id 存的。
    useAppStore.setState({
      activeId: "c1",
      conversations: [{ id: "c1", cwd: "/w", title: "对话", messages: 3 }] as never,
      workspaces: [],
      sessions: [],
      items: {},
      usage: {},
      states: {},
      perms: {},
      liveTasks: {},
      error: null,
    });
  });

  it("首次快照只用来对齐水位，不补发（避免与刚回放的转录叠成两份）", () => {
    // 新页面第一次连上：本地没有水位，快照里的 seq 就是基准。
    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "ready" }, seq: 42, epoch: "e1" },
    });
    // 之后实时来的事件（seq 43）正常应用。
    useAppStore.getState().applyEvent("c1", { kind: "cli", data: assistantLine("新的一句"), seq: 43 });
    const items = useAppStore.getState().items.c1 ?? [];
    expect(items.map((i) => ("text" in i ? i.text : ""))).toEqual(["新的一句"]);
  });

  it("补发帧里的 cli 事件按顺序落到消息流上，并带上本轮用量", () => {
    useAppStore.setState({
      items: { c1: [{ id: "u1", seq: 0, ts: Date.parse("2026-01-01T00:00:00Z"), kind: "user", text: "跑一遍测试" }] },
    });
    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "busy" }, seq: 3, epoch: "e1" },
    });

    useAppStore.getState().applyEvent("c1", {
      kind: "session.replay",
      data: {
        events: [
          { kind: "cli", seq: 2, data: assistantLine("断线期间的正文") },
          {
            kind: "cli",
            seq: 3,
            data: {
              type: "result",
              subtype: "success",
              duration_ms: 6000,
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        ],
      },
    });

    const items = useAppStore.getState().items.c1 ?? [];
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "result"]);
    expect(items[1]).toMatchObject({ kind: "assistant", text: "断线期间的正文", streaming: false });
    // 回答下面那行「耗时 · 本轮 tok」来自 result，正是断线期间丢掉的那部分。
    expect(items[1]).toMatchObject({ turn: { durationMs: 6000 } });
    expect(items[2]).toMatchObject({ kind: "result", durationMs: 6000 });
  });

  it("同一条事件既在补发帧里、又在实时广播里时只应用一次", () => {
    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "busy" }, seq: 2, epoch: "e1" },
    });
    // 实时广播先到（同步：这条不等补发帧，属于「窗口之外」，直接应用）。
    useAppStore.getState().applyEvent("c1", { kind: "cli", data: assistantLine("同一句"), seq: 3 });
    // 补发帧随后到达，包含同一条 seq 3。
    useAppStore.getState().applyEvent("c1", {
      kind: "session.replay",
      data: { events: [{ kind: "cli", seq: 3, data: assistantLine("同一句") }] },
    });

    expect((useAppStore.getState().items.c1 ?? []).filter((i) => i.kind === "assistant")).toHaveLength(1);
  });

  it("补不齐时整份重放转录，把断线期间的消息补回来", async () => {
    useAppStore.setState({
      items: { c1: [{ id: "u1", seq: 0, ts: Date.parse("2026-01-01T00:00:00Z"), kind: "user", text: "跑一遍测试" }] },
    });

    useAppStore.getState().applyEvent("c1", {
      kind: "session.resync",
      data: { seq: 7, epoch: "e2" },
    });
    // replayTranscript 是异步的：等它落地。
    await vi.waitFor(() => {
      expect((useAppStore.getState().items.c1 ?? []).some((i) => i.kind === "assistant")).toBe(true);
    });

    const items = useAppStore.getState().items.c1 ?? [];
    expect(transcriptCalls.length).toBe(1);
    // 用户气泡不能重复（本地那条 + 转录里同一条）。
    expect(items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(items.find((i) => i.kind === "assistant")).toMatchObject({ text: "断线期间跑完了" });
  });

  it("会话对象换了（epoch 变了）也整份重放，不按序号硬拼", async () => {
    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "ready" }, seq: 9, epoch: "old" },
    });
    // 进程被回收后用同一个 UUID 重新 --resume：seq 从头开始，epoch 也换了。
    useAppStore.getState().applyEvent("c1", {
      kind: "session.snapshot",
      data: { info: { state: "ready" }, seq: 1, epoch: "new" },
    });
    await vi.waitFor(() => {
      expect(transcriptCalls.length).toBe(1);
    });
  });
});
