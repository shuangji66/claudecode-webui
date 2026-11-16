import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

const childFrame = {
  type: "assistant",
  parent_tool_use_id: "toolu_01",
  agent_id: "task-1",
  message: { role: "assistant", content: [{ type: "text", text: "child says hi" }] },
};

const mainFrame = {
  type: "assistant",
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "text", text: "parent says hi" }] },
};

describe("子代理帧分流", () => {
  beforeEach(() => {
    useAppStore.setState({ items: {}, subagentItems: {}, usage: {}, doneIds: {} });
  });

  it("parent_tool_use_id 非空的帧进子代理桶，不进主消息流", () => {
    useAppStore.getState().applyEvent("s1", { kind: "cli", data: childFrame });
    const s = useAppStore.getState();
    expect(s.items.s1 ?? []).toHaveLength(0);
    expect(s.subagentItems.s1["task-1"]).toHaveLength(1);
    expect(s.subagentItems.s1["task-1"][0]).toMatchObject({ kind: "assistant", text: "child says hi" });
  });

  it("普通帧仍进主消息流", () => {
    useAppStore.getState().applyEvent("s1", { kind: "cli", data: mainFrame });
    const s = useAppStore.getState();
    expect(s.items.s1).toHaveLength(1);
    expect(s.subagentItems.s1).toBeUndefined();
  });

  it("子代理帧不污染主会话的用量", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: {
        ...childFrame,
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 999, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        },
      },
    });
    expect(useAppStore.getState().usage.s1).toBeUndefined();
  });
});
