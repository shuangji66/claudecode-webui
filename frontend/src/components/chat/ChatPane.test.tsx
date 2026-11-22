import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPane, CONN_BAR_DELAY } from "./ChatPane";
import { useAppStore } from "../../store/useAppStore";
import { askConfirm } from "../common/SystemDialogs";
import type { ConversationInfo, SessionInfo } from "../../transport/types";
import { resetBusyEnterCache, setBusyEnter } from "../../lib/busyEnter";

vi.mock("../common/SystemDialogs", () => ({ askConfirm: vi.fn(), askPrompt: vi.fn() }));

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
  vi.mocked(askConfirm).mockReset();
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

describe("ChatPane 跨提供商切模型", () => {
  // 地址与密钥在进程启动时固定：换提供商必须重启进程（同一对话 id），
  // 而重启会中断正在跑的一轮，所以选择之前要二次确认。
  const settings = {
    providers: [
      { id: "gw-a", name: "网关 A", models: ["deepseek"], model_meta: {} },
      { id: "gw-b", name: "网关 B", models: ["qwen"], model_meta: {} },
    ],
    selected: { provider: "gw-a", model: "deepseek", effort: "" },
  };

  function setupProviderSwitch(state: "busy" | "ready", answer: boolean) {
    const selectModel = vi.fn();
    setup(
      "c1",
      [conv({ messages: 2 })],
      [{ id: "c1", cwd: "/data/ws", state, provider: "gw-a", model: "deepseek" }],
    );
    act(() => {
      useAppStore.setState({ settings: settings as never, selectModel } as never);
    });
    // 确认框的答案要在点击之前就绪：点下去就会立刻 await 它。
    vi.mocked(askConfirm).mockResolvedValue(answer);
    // 模型菜单是两级：一级「模型」→ 二级里点另一家的模型。
    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /qwen/ }));
    return selectModel;
  }

  it("确认前不动会话：取消就不发设置、不重启", async () => {
    const selectModel = setupProviderSwitch("ready", false);

    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(selectModel).not.toHaveBeenCalled();
  });

  it("确认之后才交给 store（同一 id 重启）", async () => {
    const selectModel = setupProviderSwitch("ready", true);

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith("gw-b", "qwen", ""));
  });

  it("正在进行的一轮也照样确认，文案写明会被中断", async () => {
    setupProviderSwitch("busy", false);

    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    const options = vi.mocked(askConfirm).mock.calls[0][0];
    expect(String(options.message)).toContain("正在进行的一轮会被中断");
    expect(options.confirmText).toBe("重启并切换");
  });

  // 同一提供商内换模型是热切换（`set_model` 控制请求），不重启、不打断这一轮，
  // 所以不该弹确认框——多一次点击只会让人以为又要中断。
  it("同提供商换模型不弹确认，直接交给 store", async () => {
    const selectModel = vi.fn();
    const sameProvider = {
      providers: [{ id: "gw-a", name: "网关 A", models: ["deepseek", "deepseek-lite"], model_meta: {} }],
      selected: { provider: "gw-a", model: "deepseek", effort: "" },
    };
    setup(
      "c1",
      [conv({ messages: 2 })],
      [{ id: "c1", cwd: "/data/ws", state: "ready", provider: "gw-a", model: "deepseek" }],
    );
    act(() => {
      useAppStore.setState({ settings: sameProvider as never, selectModel } as never);
    });
    vi.mocked(askConfirm).mockResolvedValue(false);

    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /deepseek-lite/ }));

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith("gw-a", "deepseek-lite", ""));
    expect(askConfirm).not.toHaveBeenCalled();
  });
});

describe("ChatPane 切推理等级", () => {
  // `--effort` 只在进程启动时固定，切档位必须重启进程；重启会中断正在进行的一轮，
  // 所以和切提供商一样要二次确认。**不做「等这一轮结束自动重开」**：档位是全局设置，
  // 延迟重开是逐会话状态，两者一叠加，别的对话也会挂上「将在重开会话后生效」。
  const withEfforts = {
    providers: [
      {
        id: "gw-a",
        name: "网关 A",
        models: ["deepseek"],
        model_meta: { deepseek: { name: "DeepSeek", reasoning_efforts: ["low", "high"], supports_image: false } },
      },
    ],
    selected: { provider: "gw-a", model: "deepseek", effort: "high" },
  };

  function setupEffort(state: "busy" | "ready", answer: boolean, effort = "high") {
    const selectModel = vi.fn();
    setup(
      "c1",
      [conv({ messages: 2 })],
      [{ id: "c1", cwd: "/data/ws", state, provider: "gw-a", model: "deepseek", effort }],
    );
    act(() => {
      useAppStore.setState({ settings: withEfforts as never, selectModel } as never);
    });
    vi.mocked(askConfirm).mockResolvedValue(answer);
    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /推理等级/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));
    return selectModel;
  }

  it("取消就不改设置、不重启", async () => {
    const selectModel = setupEffort("ready", false);

    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(selectModel).not.toHaveBeenCalled();
  });

  it("确认之后才交给 store", async () => {
    const selectModel = setupEffort("ready", true);

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith("gw-a", "deepseek", "low"));
  });

  it("进行中也照样确认，文案写明会被中断", async () => {
    setupEffort("busy", false);

    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    const options = vi.mocked(askConfirm).mock.calls[0][0];
    expect(options.title).toBe("切换推理等级");
    expect(String(options.message)).toContain("正在进行的一轮会被中断");
    expect(options.confirmText).toBe("重启并切换");
  });

  // 档位没变时不重启也不弹框：白杀一次进程没有任何收益。
  it("档位没变就不弹确认", async () => {
    const selectModel = setupEffort("ready", false, "low");

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith("gw-a", "deepseek", "low"));
    expect(askConfirm).not.toHaveBeenCalled();
  });

  // 同一提供商，但新模型不支持当前档位 → effort 回落到「默认」，这同样要重启进程。
  // 模型热切换是无感的，档位变了却会打断这一轮，不能让这条路绕过确认。
  it("同提供商换到不支持当前档位的模型也要确认", async () => {
    const selectModel = vi.fn();
    const mixed = {
      providers: [
        {
          id: "gw-a",
          name: "网关 A",
          models: ["deepseek", "plain"],
          model_meta: {
            deepseek: { name: "DeepSeek", reasoning_efforts: ["low", "high"], supports_image: false },
            plain: { name: "Plain", reasoning_efforts: [], supports_image: false },
          },
        },
      ],
      selected: { provider: "gw-a", model: "deepseek", effort: "high" },
    };
    setup(
      "c1",
      [conv({ messages: 2 })],
      [{ id: "c1", cwd: "/data/ws", state: "ready", provider: "gw-a", model: "deepseek", effort: "high" }],
    );
    act(() => {
      useAppStore.setState({ settings: mixed as never, selectModel } as never);
    });
    vi.mocked(askConfirm).mockResolvedValue(false);

    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /plain/i }));

    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(vi.mocked(askConfirm).mock.calls[0][0].title).toBe("切换推理等级");
    expect(selectModel).not.toHaveBeenCalled();
  });

  // 跨对话的「将在重开会话后生效」提示必须彻底消失：档位是全局设置，别的对话里
  // 那条提示说的是「这条对话的进程不是在这个档位下起的」，而它根本不是。
  it("底栏不再显示跨对话的档位提示", () => {
    setup(
      "c1",
      [conv({ messages: 2 })],
      [{ id: "c1", cwd: "/data/ws", state: "ready", provider: "gw-a", model: "deepseek", effort: "low" }],
    );
    act(() => {
      useAppStore.setState({ settings: withEfforts as never } as never);
    });
    expect(screen.queryByText(/推理等级将在重开会话后生效/)).toBeNull();
    expect(screen.queryByText(/本轮结束后按新的推理等级重开/)).toBeNull();
  });
});
