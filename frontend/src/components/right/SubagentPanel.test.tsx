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
  // `running` 挂成 data 属性：面板必须把自己那份「在不在跑」传进去（见 SubagentPanel
  // 里 running 的注释），漏传的话子代理还在干活却会被收起来。
  MessageList: ({ items, running }: { items: Item[]; running?: boolean }) => (
    <div data-running={String(running)}>
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

// 主任务把活交给后台子代理之后，主会话往往已经 ready。面板不能借主会话的状态去判
// 「这一轮结束没有」——否则子代理还在干活，右栏却已经把思考收起来了（截图复现过）。
describe("SubagentPanel 的运行状态取自子代理自己", () => {
  const agentCard = (agentId: string, status: "running" | "completed"): Item => ({
    id: "t1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "toolu_01",
    name: "Agent",
    input: { description: "找一篇最新新闻" },
    subagent: { taskId: agentId, agentId, status },
  });

  it("主会话 ready、子代理仍在跑时，running 传 true", async () => {
    useAppStore.setState({ items: { s1: [agentCard("a1", "running")] } });
    render(<SubagentPanel sessionId="s1" agentId="a1" />);
    const box = await screen.findByText("你负责审查后端");
    expect(box.parentElement?.dataset.running).toBe("true");
  });

  it("子代理已经收尾时 running 传 false", async () => {
    useAppStore.setState({ items: { s1: [agentCard("a1", "completed")] } });
    render(<SubagentPanel sessionId="s1" agentId="a1" />);
    const box = await screen.findByText("你负责审查后端");
    expect(box.parentElement?.dataset.running).toBe("false");
  });

  it("主消息流里没有那张卡片时按不在跑算（历史对话点开的子代理）", async () => {
    useAppStore.setState({ items: {} });
    render(<SubagentPanel sessionId="s1" agentId="a1" />);
    const box = await screen.findByText("你负责审查后端");
    expect(box.parentElement?.dataset.running).toBe("false");
  });
});
