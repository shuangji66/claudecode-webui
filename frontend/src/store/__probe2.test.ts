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

const OLD = "old-1";
const NEW = "new-1";

describe("probe: /clear 的通知在换 id 时是否被冲掉", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      activeId: OLD,
      conversations: [],
      workspaces: [],
      sessions: [],
      items: { [OLD]: [] },
      usage: {},
      states: { [OLD]: "busy" },
      inits: {},
      modes: {},
      queued: {},
      liveTasks: {},
      doneIds: {},
      subagentItems: {},
      perms: {},
      conns: {},
      error: null,
    });
  });

  it("帧序 conversation_reset → session.replaced", () => {
    const st = useAppStore.getState();
    st.applyEvent(OLD, { kind: "cli", data: { type: "conversation_reset", trigger: "clear" }, seq: 1 } as never);
    console.log("after reset:", JSON.stringify(useAppStore.getState().items[OLD]?.map((i) => [i.kind, (i as any).text])));

    st.applyEvent(OLD, { kind: "session.replaced", data: { from: OLD, to: NEW }, seq: 2 } as never);
    console.log("items[OLD]:", JSON.stringify(useAppStore.getState().items[OLD]));
    console.log("items[NEW]:", JSON.stringify(useAppStore.getState().items[NEW]));
  });
});
