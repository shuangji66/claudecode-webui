import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ChatPane, CONN_BAR_DELAY } from "./ChatPane";
import { useAppStore } from "../../store/useAppStore";
import type { ConversationInfo, SessionInfo } from "../../transport/types";
import { resetBusyEnterCache, setBusyEnter } from "../../lib/busyEnter";

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
      onAddWorkspace={() => {}}
      rightOpen={false}
      onToggleRight={() => {}}
    />,
  );
}

beforeEach(() => {
  useAppStore.setState({ settings: null } as never);
  // 「繁忙时的发送行为」是模块级缓存的偏好：每个用例从默认的「排队」开始。
  localStorage.removeItem("ccweb-busy-enter");
  resetBusyEnterCache();
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

describe("ChatPane 回合计时", () => {
  function setupTurn(state: "busy" | "ready") {
    useAppStore.setState({
      activeId: "c1",
      conversations: [conv({ messages: 1 })],
      sessions: [{ id: "c1", cwd: "/data/ws", state }],
      items: {
        c1: [{ id: "u1", seq: 0, ts: Date.now() - 5_000, kind: "user", text: "跑一下测试", streaming: false }],
      },
      perms: {},
      inits: {},
      states: { c1: state },
      conns: {},
      usage: {},
      starting: false,
      currentWorkspace: "/data/ws",
      workspaces: [{ path: "/data/ws", name: "ws", created_at: "2026-01-01T00:00:00Z" }],
    } as never);
    render(
      <ChatPane
        onToggleSidebar={() => {}}
          onAddWorkspace={() => {}}
        rightOpen={false}
        onToggleRight={() => {}}
      />,
    );
  }

  it("工作中显示「少女祈祷中」与已进行时间", () => {
    setupTurn("busy");
    expect(screen.getByText("少女祈祷中")).toBeInTheDocument();
    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("空闲时不显示计时行", () => {
    setupTurn("ready");
    expect(screen.queryByText("少女祈祷中")).not.toBeInTheDocument();
  });

  // 底栏那行操作提示必须与「繁忙时的发送行为」一致：偏好在哪一档、Enter 投递哪一档。
  // 写反了用户照着提示按，得到的是相反的结果（而且不会报错）。
  it("底栏提示跟着发送行为：默认排队", () => {
    setupTurn("busy");
    expect(screen.getByText("Enter 排队 · Ctrl+Enter 立即插话")).toBeInTheDocument();
  });

  it("底栏提示跟着发送行为：偏好插话时两档互换", () => {
    setBusyEnter("steer");
    setupTurn("busy");
    expect(screen.getByText("Enter 插话 · Ctrl+Enter 排队")).toBeInTheDocument();
    expect(screen.queryByText("Enter 排队 · Ctrl+Enter 立即插话")).toBeNull();
  });
});

describe("ChatPane 连接横幅", () => {
  // 打开既有对话时历史已经先上屏，握手就那几十毫秒：这时候插一条横幅会把消息区
  // 顶下去再拉回来，看起来就是「claude 一拉起整个界面闪一下」。
  afterEach(() => {
    vi.useRealTimers();
  });

  it("握手期间不插横幅，真的连不上才出现", () => {
    vi.useFakeTimers();
    setup("c1", [conv({ messages: 2 })], [session("c1")]);
    act(() => {
      useAppStore.setState({ conns: { c1: { state: "connecting" } } } as never);
    });
    // 页面刚打开：历史在屏幕上，连接还在握手，不要多一行。
    expect(screen.queryByText(/正在连接/)).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(CONN_BAR_DELAY - 100);
    });
    expect(screen.queryByText(/正在连接/)).not.toBeInTheDocument();
    // 过了阈值仍然没连上：这才需要告诉用户，并给出「立即重试」。
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText(/正在连接/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /立即重试/ })).toBeInTheDocument();
  });

  it("连上以后不残留横幅", () => {
    vi.useFakeTimers();
    setup("c1", [conv({ messages: 2 })], [session("c1")]);
    act(() => {
      useAppStore.setState({ conns: { c1: { state: "connecting" } } } as never);
    });
    act(() => {
      useAppStore.setState({ conns: { c1: { state: "open" } } } as never);
    });
    act(() => {
      vi.advanceTimersByTime(CONN_BAR_DELAY + 100);
    });
    expect(screen.queryByText(/正在连接/)).not.toBeInTheDocument();
  });

  it("连接被关闭是终态，立刻说", () => {
    setup("c1", [conv({ messages: 2 })], [session("c1")]);
    act(() => {
      useAppStore.setState({ conns: { c1: { state: "closed" } } } as never);
    });
    expect(screen.getByText(/连接已关闭/)).toBeInTheDocument();
  });
});
