// 草稿与对话的生命周期：建会话时把「新对话页」的草稿迁到新 id，删对话时丢掉草稿。
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; init?: RequestInit }> = [];
let sessionReply: { id: string; cwd: string; state: string } = { id: "new-1", cwd: "/w", state: "ready" };

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/session" && init?.method === "POST") return sessionReply;
      if (url === "/api/session") return { ok: true, sessions: [] };
      return { ok: true, conversations: [] };
    }),
  };
});

const { useAppStore } = await import("./useAppStore");
const { readDraft, writeDraft } = await import("../lib/drafts");

function seed() {
  calls.length = 0;
  sessionReply = { id: "new-1", cwd: "/w", state: "ready" };
  localStorage.clear();
  useAppStore.setState({
    activeId: null,
    currentWorkspace: "/w",
    workspaces: [{ path: "/w", name: "w", last_used: "", exists: true }],
    sessions: [],
    conversations: [{ id: "c1", cwd: "/w", title: "第一个对话", messages: 2, archived: false, live: false }],
    items: {},
    error: null,
    // 真连 WS 会开 socket：这两条动作在测试里不该被触发。
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    refreshConversations: vi.fn(async () => {}),
  } as never);
}

describe("草稿跟着对话走", () => {
  beforeEach(() => seed());

  it("新会话建好后，新对话页按工作区存的草稿迁到新 id 下", async () => {
    writeDraft("ws:/w", "还没建会话时打的字");
    await useAppStore.getState().createSession("/w");

    expect(useAppStore.getState().activeId).toBe("new-1");
    // 键换了字不能丢：Composer 会按新 id 读草稿。
    expect(readDraft("new-1")).toBe("还没建会话时打的字");
    expect(readDraft("ws:/w")).toBe("");
  });

  it("别的对话的草稿不受影响", async () => {
    writeDraft("c1", "c1 的草稿");
    writeDraft("ws:/w", "新对话页的草稿");
    await useAppStore.getState().createSession("/w");
    expect(readDraft("c1")).toBe("c1 的草稿");
  });

  it("空对话重开（换模型/推理等级会换 id）时草稿跟着新 id 走", async () => {
    useAppStore.setState({
      activeId: "c1",
      conversations: [{ id: "c1", cwd: "/w", title: "", messages: 0, archived: false, live: true }],
      sessions: [{ id: "c1", cwd: "/w", state: "ready" }],
    } as never);
    writeDraft("c1", "还没发出去的字");
    sessionReply = { id: "c9", cwd: "/w", state: "ready" };

    await useAppStore.getState().restartSession("c1");

    expect(useAppStore.getState().activeId).toBe("c9");
    expect(readDraft("c9")).toBe("还没发出去的字");
    expect(readDraft("c1")).toBe("");
  });

  it("删对话时把它的草稿一并清掉", async () => {
    writeDraft("c1", "留着也没用了");
    await useAppStore.getState().deleteConversation("c1");
    expect(readDraft("c1")).toBe("");
  });
});
