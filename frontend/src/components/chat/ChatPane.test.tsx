import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatPane } from "./ChatPane";
import { useAppStore } from "../../store/useAppStore";
import type { ConversationInfo, SessionInfo } from "../../transport/types";

function conv(over: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id: "c1",
    cwd: "/data/ws",
    title: "",
    created_at: "2026-01-01T00:00:00Z",
    last_active: "2026-01-01T00:00:00Z",
    messages: 0,
    archived: false,
    live: true,
    ...over,
  };
}

function session(id: string): SessionInfo {
  return { id, cwd: "/data/ws", state: "idle" };
}

function setup(activeId: string | null, conversations: ConversationInfo[], sessions: SessionInfo[] = []) {
  useAppStore.setState({
    activeId,
    conversations,
    sessions,
    items: {},
    perms: {},
    inits: {},
    states: {},
    conns: {},
    usage: {},
    starting: false,
    currentWorkspace: "/data/ws",
    workspaces: [{ path: "/data/ws", name: "ws", created_at: "2026-01-01T00:00:00Z" }],
  } as never);
  render(
    <ChatPane
      onToggleSidebar={() => {}}
      onToggleCollapse={() => {}}
      onOpenSettings={() => {}}
      onAddWorkspace={() => {}}
      rightOpen={false}
      onToggleRight={() => {}}
    />,
  );
}

beforeEach(() => {
  useAppStore.setState({ settings: null } as never);
});

describe("ChatPane 新对话布局", () => {
  // 点了「新对话」后 activeId 已经有了，但一条消息都没发：仍然要居中，
  // 并且保留工作区选择器（否则新建后布局立刻变成贴底、选择器消失）。
  it("刚建的空会话也用居中布局并显示工作区选择器", () => {
    setup("c1", [conv({ messages: 0 })], [session("c1")]);
    expect(screen.getByRole("button", { name: "工作区" })).toBeInTheDocument();
    // 居中页的品牌区文案（顶栏标题也叫「新对话」，所以认这句提示语）。
    expect(screen.getByText(/输入消息即可开始新的对话/)).toBeInTheDocument();
  });

  it("没有会话时同样是居中布局", () => {
    setup(null, []);
    expect(screen.getByRole("button", { name: "工作区" })).toBeInTheDocument();
  });

  // 历史对话的转录是异步拉回来的：items 暂时为空也不能当成新对话，
  // 否则每次点开旧对话都会先闪一下新对话页。
  it("有消息的对话不显示工作区选择器", () => {
    setup("c1", [conv({ messages: 4 })], [session("c1")]);
    expect(screen.queryByRole("button", { name: "工作区" })).not.toBeInTheDocument();
  });
});
