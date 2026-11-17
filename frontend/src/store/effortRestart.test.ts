import { beforeEach, describe, expect, it, vi } from "vitest";

/** 记录 apiFetch 的调用，按 URL 给不同响应。 */
const calls: Array<{ url: string; init?: RequestInit }> = [];

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/settings") {
        return { providers: [], selected: { provider: "gw", model: "m1", effort: "low" } };
      }
      if (url === "/api/sessions") {
        return { sessions: [{ id: "s1", cwd: "/w", provider: "gw", model: "m1", effort: "high", state: "ready" }] };
      }
      if (url === "/api/session") {
        return { id: "s1", cwd: "/w", provider: "gw", model: "m1", effort: "low", state: "starting" };
      }
      return {};
    }),
  };
});

const { useAppStore } = await import("./useAppStore");

function seed(state: string) {
  calls.length = 0;
  useAppStore.setState({
    activeId: "s1",
    conversations: [{ id: "s1", cwd: "/w", title: "对话", messages: 2 }] as never,
    sessions: [{ id: "s1", cwd: "/w", provider: "gw", model: "m1", effort: "high", state }] as never,
    states: { s1: state },
    items: {},
    subagentItems: {},
    perms: {},
    inits: {},
    conns: {},
    usage: {},
    doneIds: {},
    settings: { providers: [], selected: { provider: "gw", model: "m1", effort: "high" } } as never,
    error: null,
    // 重开会话会真的建 WS：测试里换掉收发两条腿。
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as never);
}

describe("切推理等级后让它生效", () => {
  beforeEach(() => seed("ready"));

  it("空闲会话按同一 id 关掉再 --resume 拉起，上下文不丢", async () => {
    await useAppStore.getState().selectModel("gw", "m1", "low");

    const del = calls.find((c) => c.url.startsWith("/api/session?id="));
    expect(del?.init?.method).toBe("DELETE");
    const resume = calls.find((c) => c.url === "/api/session" && c.init?.method === "POST");
    expect(JSON.parse(String(resume?.init?.body))).toEqual({ cwd: "/w", resume: "s1" });
    expect(useAppStore.getState().connect).toHaveBeenCalledWith("s1");
  });

  it("进行中不杀进程：等这一轮 result 到了再重开", async () => {
    seed("busy");
    await useAppStore.getState().selectModel("gw", "m1", "low");
    expect(calls.some((c) => c.url.startsWith("/api/session?id="))).toBe(false);

    // 这一轮结束（result）之后才重开。
    useAppStore.getState().applyEvent("s1", { kind: "cli", data: { type: "result" } } as never);
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.startsWith("/api/session?id="))).toBe(true);
    });
  });

  it("还没发过消息的对话没有转录：重开一个新会话，而不是 --resume", async () => {
    seed("ready");
    useAppStore.setState({
      conversations: [{ id: "s1", cwd: "/w", title: "", messages: 0 }] as never,
      items: {},
    } as never);

    await useAppStore.getState().selectModel("gw", "m1", "low");

    // 空对话 Resume 一定失败（转录不存在）：必须走「关掉 + 新建」。
    const created = calls.filter((c) => c.url === "/api/session" && c.init?.method === "POST");
    expect(created.length).toBe(1);
    expect(JSON.parse(String(created[0].init?.body))).not.toHaveProperty("resume");
  });

  it("档位没变就不重开（换模型时尤其不能白杀一次进程）", async () => {
    await useAppStore.getState().selectModel("gw", "m1", "high");
    expect(calls.some((c) => c.url.startsWith("/api/session?id="))).toBe(false);
  });
});
