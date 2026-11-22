import { beforeEach, describe, expect, it, vi } from "vitest";

/** 记录 apiFetch 的调用，按 URL 给不同响应。 */
const calls: Array<{ url: string; init?: RequestInit }> = [];
/** 让某一次 POST /api/session 失败（测试「起不来」的收尾）。 */
let sessionPostFails = false;
/** 让 DELETE /api/session 回 404（进程已被空闲回收 / 别的设备关掉）。 */
let sessionDeleteFails = false;

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
      if (url.startsWith("/api/session?id=") && sessionDeleteFails) {
        throw new Error("manager: 会话 s1 不存在");
      }
      if (url === "/api/session" && init?.method === "POST") {
        if (sessionPostFails) throw new Error("manager: 会话池已满");
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

  it("还没发过消息的对话也按同一 id 重起，不新建对话", async () => {
    seed("ready");
    useAppStore.setState({
      conversations: [{ id: "s1", cwd: "/w", title: "", messages: 0 }] as never,
      items: {},
    } as never);

    await useAppStore.getState().selectModel("gw", "m1", "low");

    // 没有转录时后端会用 StartFresh 按同一个 UUID 新建（根 AGENTS 4.4），
    // 所以前端照样发 resume：**不换 id**，否则每切一次就多一条「新对话」。
    const created = calls.filter((c) => c.url === "/api/session" && c.init?.method === "POST");
    expect(created.length).toBe(1);
    expect(JSON.parse(String(created[0].init?.body))).toEqual({ cwd: "/w", resume: "s1" });
  });

  it("档位没变就不重开（换模型时尤其不能白杀一次进程）", async () => {
    await useAppStore.getState().selectModel("gw", "m1", "high");
    expect(calls.some((c) => c.url.startsWith("/api/session?id="))).toBe(false);
  });
});

describe("跨提供商切换模型", () => {
  beforeEach(() => seed("ready"));

  // 地址与密钥在进程启动时固定，只能重启进程；但必须按**同一个对话 id** 重开，
  // 不能像以前那样 close + create —— 那会把上下文留在旧对话里，还会多出一条「新对话」。
  it("按同一 id 关掉再 --resume，不新建对话", async () => {
    await useAppStore.getState().selectModel("other", "m2", "");

    const del = calls.find((c) => c.url.startsWith("/api/session?id="));
    expect(del?.init?.method).toBe("DELETE");
    const created = calls.filter((c) => c.url === "/api/session" && c.init?.method === "POST");
    expect(created.length).toBe(1);
    expect(JSON.parse(String(created[0].init?.body))).toEqual({ cwd: "/w", resume: "s1" });
  });

  it("进行中切换也走同一 id 重启（中断这一轮，确认由界面负责）", async () => {
    seed("busy");
    await useAppStore.getState().selectModel("other", "m2", "");

    const created = calls.filter((c) => c.url === "/api/session" && c.init?.method === "POST");
    expect(created.length).toBe(1);
    expect(JSON.parse(String(created[0].init?.body))).toEqual({ cwd: "/w", resume: "s1" });
    expect(useAppStore.getState().error).toBeNull();
  });

  // 连点两次模型菜单 / 切档位与切提供商撞在一起：只该有一次 DELETE + POST，
  // 否则后一次会把前一次刚拉起来的进程再关掉。
  it("同一 id 同时重开只跑一份", async () => {
    const [a, b] = await Promise.all([
      useAppStore.getState().restartSession("s1"),
      useAppStore.getState().restartSession("s1"),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("/api/session?id=")).length).toBe(1);
    expect(calls.filter((c) => c.url === "/api/session" && c.init?.method === "POST").length).toBe(1);
  });

  // 进程已经被空闲回收 / 别的设备关掉时 DELETE 会 404：那不算失败，照样要把它拉起来。
  it("DELETE 失败不影响重开", async () => {
    sessionDeleteFails = true;
    try {
      const ok = await useAppStore.getState().restartSession("s1");
      expect(ok).toBe(true);
      expect(calls.filter((c) => c.url === "/api/session" && c.init?.method === "POST").length).toBe(1);
      expect(useAppStore.getState().error).toBeNull();
    } finally {
      sessionDeleteFails = false;
    }
  });

  // 新进程起不来时必须把界面从「正在启动」放下来：那个状态只由新的 connect 收掉，
  // 而这次根本没连上——不放下来输入框会一直禁用、连接横幅一直转。
  it("重开失败要把状态放回 closed 并给出原因", async () => {
    sessionPostFails = true;
    try {
      const ok = await useAppStore.getState().restartSession("s1");
      expect(ok).toBe(false);
      const s = useAppStore.getState();
      expect(s.states.s1).toBe("closed");
      expect(s.conns.s1?.state).toBe("closed");
      expect(s.error).toContain("会话池已满");
    } finally {
      sessionPostFails = false;
    }
  });
});
