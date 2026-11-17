import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, apiFetch: vi.fn(async () => ({})) };
});

const { useAppStore } = await import("./useAppStore");

/** 把真正发消息的那一步换掉：这里只验证队列的进出与投递时机，不碰 WS。 */
const sendPrompt = vi.fn(async () => true);

function reset(activeId: string | null = "s1", state = "busy") {
  useAppStore.getState().setEditingQueued(null);
  sendPrompt.mockClear();
  sendPrompt.mockResolvedValue(true);
  useAppStore.setState({
    activeId,
    conversations: [{ id: "s1", cwd: "/w", title: "对话", messages: 1 }] as never,
    sessions: [{ id: "s1", cwd: "/w", state }] as never,
    items: {},
    subagentItems: {},
    perms: {},
    states: activeId ? { [activeId]: state } : {},
    inits: {},
    conns: {},
    usage: {},
    doneIds: {},
    modes: {},
    queued: {},
    settings: { providers: [], selected: { provider: "", model: "" } } as never,
    error: null,
    sendPrompt: sendPrompt as never,
  } as never);
}

const queueOf = (sid = "s1") => useAppStore.getState().queued[sid] ?? [];

/** 直接摆一条待发送（绕开「入队即发」的路径，模拟断线期间攒下来的消息）。 */
function seedQueue(sid: string, text: string) {
  reset(sid, "ready");
  useAppStore.setState({
    queued: { [sid]: [{ id: "q1", text, attachments: [], label: "附件：", ts: 1 }] },
  } as never);
  sendPrompt.mockClear();
}

describe("待发送队列", () => {
  beforeEach(() => reset());

  it("回合进行中按 Enter 只入队，不发给 claude", async () => {
    expect(useAppStore.getState().enqueuePrompt("改成不用 lodash")).toBe(true);
    await Promise.resolve();

    expect(queueOf().map((q) => q.text)).toEqual(["改成不用 lodash"]);
    expect(sendPrompt).not.toHaveBeenCalled();
    // 还没写进 claude，就不该在消息流里插用户气泡（否则会显示成已发送）。
    expect(useAppStore.getState().items.s1 ?? []).toHaveLength(0);
  });

  it("这一轮正常结束（result）就自动发队首，一条一条来", async () => {
    useAppStore.getState().enqueuePrompt("第一条");
    useAppStore.getState().enqueuePrompt("第二条");
    // 后端的顺序是「先 ready 再 result」：状态事件不触发发送，真正的触发点是 result。
    useAppStore.getState().applyEvent("s1", { kind: "session.state", data: { state: "ready" } } as never);
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "result", subtype: "success", is_error: false },
    } as never);
    await Promise.resolve();

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith("第一条", [], "附件：");
    expect(queueOf().map((q) => q.text)).toEqual(["第二条"]);
  });

  it("切对话、重连（只到 ready）都不自动发：那是被中断后暂停的队列", async () => {
    seedQueue("s1", "暂停的队列");

    useAppStore.getState().applyEvent("s1", { kind: "session.state", data: { state: "ready" } } as never);
    useAppStore.getState().setActive("s1");
    await Promise.resolve();

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);
  });

  it("只收到 result 也会补发", async () => {
    seedQueue("s1", "补发我");

    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "result", subtype: "success", is_error: false },
    } as never);
    await Promise.resolve();

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(queueOf()).toHaveLength(0);
  });

  it("被中断 / 出错时留在队列里，等用户自己决定", async () => {
    seedQueue("s1", "别做了，先说明思路");

    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "result", subtype: "interrupted", is_error: true },
    } as never);
    await Promise.resolve();

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);
  });

  it("空闲时 Enter 语义不变：入队后立刻发出去", async () => {
    reset("s1", "ready");
    useAppStore.getState().enqueuePrompt("你好");
    await Promise.resolve();

    expect(sendPrompt).toHaveBeenCalledWith("你好", [], "附件：");
    expect(queueOf()).toHaveLength(0);
  });

  it("「立即插话」把这一条现在就写信道，不再留在队列里", async () => {
    useAppStore.getState().enqueuePrompt("先跑测试");
    const id = queueOf()[0].id;

    await useAppStore.getState().steerQueued(id);

    expect(sendPrompt).toHaveBeenCalledWith("先跑测试", [], "附件：");
    expect(queueOf()).toHaveLength(0);
  });

  it("发失败就把消息放回队首，不凭空消失", async () => {
    sendPrompt.mockResolvedValue(false);
    useAppStore.getState().enqueuePrompt("这条不能丢");
    const id = queueOf()[0].id;

    await useAppStore.getState().steerQueued(id);

    expect(queueOf().map((q) => q.text)).toEqual(["这条不能丢"]);
  });

  it("队列跟着对话走：切到别的对话时不替他发", async () => {
    useAppStore.getState().enqueuePrompt("留给 s1");
    useAppStore.setState({ activeId: "s2", states: { s1: "ready" } } as never);

    const flushed = await useAppStore.getState().flushQueued("s1");

    expect(flushed).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);
  });

  it("改一条：正文更新、位置不变", () => {
    seedQueue("s1", "原来的说法");
    useAppStore.getState().editQueued("q1", "  换个说法  ");

    const q = queueOf();
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe("换个说法");
  });

  it("正在编辑的队首会被按住，编辑结束后补发", async () => {
    seedQueue("s1", "改到一半的那条");
    useAppStore.getState().setEditingQueued("q1");

    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "result", subtype: "success", is_error: false },
    } as never);
    await Promise.resolve();
    // 这一轮结束了，但那条正在被编辑：绝不能把旧文本发出去。
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);

    useAppStore.getState().editQueued("q1", "改完了的版本");
    useAppStore.getState().setEditingQueued(null);
    await Promise.resolve();

    expect(sendPrompt).toHaveBeenCalledWith("改完了的版本", [], "附件：");
    expect(queueOf()).toHaveLength(0);
  });

  it("删掉一条：只影响它，其余顺序不变", () => {
    useAppStore.getState().enqueuePrompt("第一条");
    useAppStore.getState().enqueuePrompt("第二条");
    useAppStore.getState().enqueuePrompt("第三条");
    const mid = queueOf()[1].id;

    useAppStore.getState().dropQueued(mid);

    expect(queueOf().map((q) => q.text)).toEqual(["第一条", "第三条"]);
  });

  it("队列满了拒绝入队并提示，不静默丢弃", () => {
    for (let i = 0; i < 8; i += 1) expect(useAppStore.getState().enqueuePrompt(`第 ${i} 条`)).toBe(true);

    expect(useAppStore.getState().enqueuePrompt("第 9 条")).toBe(false);
    expect(queueOf()).toHaveLength(8);
    expect(useAppStore.getState().error).toContain("最多");
  });
});
