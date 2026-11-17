import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; init?: RequestInit }> = [];

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/settings") {
        const patch = init?.body ? JSON.parse(String(init.body)) : {};
        return {
          providers: [],
          selected: { provider: "", model: "" },
          permission_mode: patch.permission_mode ?? "default",
        };
      }
      return {};
    }),
  };
});

const { useAppStore } = await import("./useAppStore");

function reset() {
  calls.length = 0;
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
    modes: {},
    settings: { providers: [], selected: { provider: "", model: "" }, permission_mode: "default" } as never,
    error: null,
  } as never);
}

describe("权限模式", () => {
  beforeEach(reset);

  it("CLI 报上来的模式覆盖界面自己记的那份", () => {
    useAppStore.getState().applyEvent("s1", { kind: "session.state", data: { mode: "plan" } } as never);
    expect(useAppStore.getState().modes.s1).toBe("plan");
  });

  it("重连快照用 info.mode，而不是启动时的 init 快照", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "session.snapshot",
      data: {
        init: { current_permission_mode: "default" },
        info: { state: "ready", mode: "plan" },
        permissions: [],
      },
    } as never);
    // 用户在这次连接之前就把会话切到了 plan：界面必须显示 plan。
    expect(useAppStore.getState().modes.s1).toBe("plan");
  });

  it("还没有活着的进程时，切换写进默认权限（建会话时生效）", async () => {
    await useAppStore.getState().setPermissionMode("plan");
    const patch = calls.find((c) => c.url === "/api/settings" && c.init?.method === "PUT");
    expect(patch).toBeTruthy();
    expect(JSON.parse(String(patch?.init?.body)).permission_mode).toBe("plan");
    expect(useAppStore.getState().settings?.permission_mode).toBe("plan");
  });
});
