import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

/**
 * 子代理的实时用量：CLI 的 `task_progress`（带 usage）只在子代理调用过工具之后才发，
 * 纯思考的子代理结束前一条都没有。`--forward-subagent-text` 转发的 assistant 帧一直
 * 带着 usage，store 在这里顺手把它记成「最后一次请求的 prompt + output」。
 */
const frame = (usage: Record<string, number>) => ({
  kind: "cli" as const,
  data: {
    type: "assistant",
    parent_tool_use_id: "tu1",
    agent_id: "a1",
    message: { role: "assistant", content: [{ type: "text", text: "想一下" }], usage },
  },
});

describe("子代理的实时 token 用量", () => {
  beforeEach(() => {
    useAppStore.setState({ subagentItems: {}, subagentTokens: {} });
  });

  it("从转发的 assistant 帧记下 prompt + output", () => {
    useAppStore.getState().applyEvent("s1", frame({ input_tokens: 300, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 700, output_tokens: 500 }));
    expect(useAppStore.getState().subagentTokens.s1).toEqual({ a1: 10_500 });
  });

  it("后续请求覆盖成最新一次（与 CLI 的 subagent_tokens 同口径，不累加）", () => {
    useAppStore.getState().applyEvent("s1", frame({ input_tokens: 100, output_tokens: 200 }));
    useAppStore.getState().applyEvent("s1", frame({ input_tokens: 400, output_tokens: 100 }));
    expect(useAppStore.getState().subagentTokens.s1).toEqual({ a1: 500 });
  });

  it("主链上的 assistant 帧不进这张表", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "cli",
      data: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "回答" }], usage: { input_tokens: 1, output_tokens: 2 } } },
    });
    expect(useAppStore.getState().subagentTokens.s1).toBeUndefined();
  });
});
