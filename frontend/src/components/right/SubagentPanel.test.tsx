import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentPanel } from "./SubagentPanel";
import type { Item } from "../../lib/model";
import { useAppStore } from "../../store/useAppStore";

// 面板只做「拼条目 + 交给 MessageList」，转录接口与消息渲染都打桩。
vi.mock("../../lib/runtime", () => ({
  apiFetch: vi.fn(async () => ({
    lines: [
      { type: "user", isSidechain: true, message: { role: "user", content: "你负责审查后端" } },
      { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "我先读一遍。" }] } },
    ],
    meta: { description: "审查后端", agentType: "general-purpose" },
  })),
}));

vi.mock("../chat/MessageList", () => ({
  MessageList: ({ items }: { items: Item[] }) => (
    <div>
      {items.map((it) => (
        <p key={it.id} data-kind={it.kind}>
          {it.kind === "user" || it.kind === "assistant" || it.kind === "thinking" ? it.text : `<${it.kind}>`}
        </p>
      ))}
    </div>
  ),
}));

beforeEach(() => {
  useAppStore.setState({ subagentItems: {} });
});

describe("SubagentPanel 派发消息", () => {
  /** 实时流只带子代理自己说的话（prompt 是主会话那条 tool_use 的入参，不会出现在它 stdout 里）。 */
  const live = (): Item[] => [
    { id: "l1", seq: 0, ts: 1, kind: "assistant", text: "我先读一遍。", streaming: false },
  ];

  it("实时流里没有派发消息时，从转录补上（否则面板没有开头的问题）", async () => {
    useAppStore.setState({ subagentItems: { s1: { a1: live() } } });
    render(<SubagentPanel sessionId="s1" agentId="a1" />);

    expect(await screen.findByText("你负责审查后端")).toBeInTheDocument();
    expect(screen.getByText("我先读一遍。")).toBeInTheDocument();
    // 转录里的那条 assistant 不该重复（实时那份已经有一份）。
    expect(screen.getAllByText("我先读一遍。")).toHaveLength(1);
  });

  it("实时流自己带了 user 条目时不重复补", async () => {
    useAppStore.setState({
      subagentItems: {
        s1: {
          a1: [
            { id: "u1", seq: 0, ts: 0, kind: "user", text: "实时转发过来的问题" },
            ...live(),
          ],
        },
      },
    });
    render(<SubagentPanel sessionId="s1" agentId="a1" />);
    expect(await screen.findByText("实时转发过来的问题")).toBeInTheDocument();
    expect(screen.queryByText("你负责审查后端")).toBeNull();
  });

  it("没有实时流时整份用转录", async () => {
    render(<SubagentPanel sessionId="s1" agentId="a1" />);
    expect(await screen.findByText("你负责审查后端")).toBeInTheDocument();
    expect(screen.getByText("我先读一遍。")).toBeInTheDocument();
  });
});
