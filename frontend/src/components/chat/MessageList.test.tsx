import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { Item } from "../../lib/model";
import {
  resetCollapseTimingCache,
  resetFoldedRepliesCache,
  resetProcessViewCache,
  setFoldedReplies,
  setCollapseTiming,
  setProcessView,
} from "../../lib/viewMode";
import { useAppStore } from "../../store/useAppStore";

/**
 * 会话此刻在不在跑：过程组「运行中 / 保留期」只认这个（回放的转录里没有 result 行，
 * 不能靠扫列表猜）。默认按「空闲」处理，需要「进行中」的用例自己调。
 */
function setSessionRunning(running: boolean) {
  useAppStore.setState({ activeId: "s1", states: { s1: running ? "busy" : "ready" } });
}

beforeEach(() => {
  setSessionRunning(false);
  // 过程展示偏好存在模块缓存里：每个用例从默认的「标准」开始。
  resetProcessViewCache();
  setProcessView("standard");
  resetCollapseTimingCache();
  setCollapseTiming("onComplete");
  resetFoldedRepliesCache();
  setFoldedReplies("all");
});

function userItem(i: number): Item {
  return { id: `u${i}`, seq: i, ts: 0, kind: "user", text: `消息 ${i}` };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => userItem(i));

/** jsdom 里滚动几何全是 0：按需给元素补上可测的尺寸。 */
function sizedScroller(scrollHeight = 1000, clientHeight = 500) {
  const el = screen.getByTestId("message-scroller");
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTo", { value: vi.fn(), configurable: true });
  return el as HTMLElement;
}

describe("MessageList 长对话", () => {
  it("默认只渲染最近 80 条，点「加载更早」再展开一批", () => {
    render(<MessageList items={many(200)} />);

    expect(screen.getByText("消息 199")).toBeInTheDocument();
    expect(screen.queryByText("消息 0")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /加载更早的 80 条/ }));

    // 展开后是最近 160 条：从 40 开始
    expect(screen.getByText("消息 40")).toBeInTheDocument();
    expect(screen.queryByText("消息 39")).toBeNull();
    expect(screen.getByRole("button", { name: /加载更早的 40 条/ })).toBeInTheDocument();
  });

  it("往上翻时出现回到底部按钮，点击后消失", () => {
    render(<MessageList items={many(5)} />);
    const el = sizedScroller();

    // 远离底部：1000 - 0 - 500 = 500
    fireEvent.scroll(el);
    const fab = screen.getByRole("button", { name: "回到底部" });
    expect(fab).toBeInTheDocument();

    fireEvent.click(fab);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });

  it("不贴底时来了新消息，按钮提示「有新内容」", () => {
    const { rerender } = render(<MessageList items={many(5)} />);
    const el = sizedScroller();
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeInTheDocument();

    rerender(<MessageList items={[...many(5), userItem(99)]} />);
    expect(screen.getByRole("button", { name: "有新内容，回到底部" })).toBeInTheDocument();
  });

  it("切换对话（resetKey 变化）后回到只渲染最近一批", () => {
    const { rerender } = render(<MessageList items={many(200)} resetKey="a" />);
    fireEvent.click(screen.getByRole("button", { name: /加载更早的/ }));
    expect(screen.queryByText("消息 39")).toBeNull();

    rerender(<MessageList items={many(200)} resetKey="b" />);
    expect(screen.queryByText("消息 0")).toBeNull();
    expect(screen.getByRole("button", { name: /加载更早的 80 条/ })).toBeInTheDocument();
  });
});

describe("MessageList 轮次刻度", () => {
  function conversation(turns: number): Item[] {
    const out: Item[] = [];
    for (let i = 0; i < turns; i += 1) {
      out.push({ id: `u${i}`, seq: i * 2, ts: 0, kind: "user", text: `问题 ${i}` });
      out.push({ id: `a${i}`, seq: i * 2 + 1, ts: 0, kind: "assistant", text: `回答 ${i}`, streaming: false });
    }
    return out;
  }

  it("每条用户消息一个刻度，当前轮高亮", () => {
    render(<MessageList items={conversation(3)} />);
    expect(screen.getByRole("button", { name: /跳到第 1 轮：问题 0/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /跳到第 3 轮：问题 2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /跳到第 1 轮/ })).toHaveAttribute("aria-current", "true");
  });

  // 刻度是从正文右侧硬挤出来的 20px，3px 高的刻度在手机上也不好点；
  // 手机上整条隐藏，并保留原生滚动条当「还能滚」的提示。
  it("刻度栏只在 md 以上渲染", () => {
    render(<MessageList items={conversation(3)} />);
    expect(screen.getByTestId("turn-rail")).toHaveClass("hidden", "md:flex");
  });

  it("点被窗口截掉的刻度会先展开再跳", () => {
    render(<MessageList items={conversation(100)} />);
    // 默认只渲染最近 80 条，第一条问题早被截掉
    expect(screen.queryByText("问题 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /跳到第 1 轮/ }));
    expect(screen.getByText("问题 0")).toBeInTheDocument();
  });
});

describe("MessageList 滚动性能", () => {
  function conversation(turns: number): Item[] {
    const out: Item[] = [];
    for (let i = 0; i < turns; i += 1) {
      out.push({ id: `u${i}`, seq: i * 2, ts: 0, kind: "user", text: `问题 ${i}` });
      out.push({ id: `a${i}`, seq: i * 2 + 1, ts: 0, kind: "assistant", text: `回答 ${i}`, streaming: false });
    }
    return out;
  }

  const flushFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  it("滚动帧只读缓存，不再逐轮 querySelector + 读几何", async () => {
    render(<MessageList items={conversation(60)} />);
    const el = sizedScroller();

    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const querySpy = vi.spyOn(Element.prototype, "querySelector");
    rectSpy.mockClear();
    querySpy.mockClear();

    // 连续滚 8 帧：旧实现每帧对每一轮做一次 querySelector + getBoundingClientRect，
    // 60 轮就是 480 次查询与 8 次强制布局。
    for (let i = 0; i < 8; i += 1) {
      fireEvent.scroll(el);
      await flushFrame();
    }

    expect(rectSpy.mock.calls.length).toBe(0);
    expect(querySpy.mock.calls.length).toBe(0);
    rectSpy.mockRestore();
    querySpy.mockRestore();
  });
});

describe("MessageList 本轮用量", () => {
  it("时长只出现一次：回填到回答那一行后，result 条不再重复", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "问题" },
      { id: "a1", seq: 1, ts: 0, kind: "assistant", text: "答案", streaming: false, turn: { durationMs: 5000 } },
      { id: "r1", seq: 2, ts: 0, kind: "result", durationMs: 5000, denials: [], isError: false },
    ];
    render(<MessageList items={items} />);
    expect(screen.getAllByText("00:05")).toHaveLength(1);
  });
});

describe("MessageList 过程展示", () => {
  // 这一段演的都是「这一轮正在跑」：过程组要靠 result 或会话状态才收起。
  beforeEach(() => setSessionRunning(true));
  const thinking = (text: string): Item => ({ id: "th1", seq: 0, ts: 0, kind: "thinking", text });
  const read = (): Item => ({
    id: "t1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Read",
    input: { file_path: "/w/a.md" },
    result: "内容",
  });
  const bash = (): Item => ({
    id: "t2",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu2",
    name: "Bash",
    input: { command: "ls -la" },
    result: "a\nb",
  });
  const answer: Item = { id: "a1", seq: 0, ts: 0, kind: "assistant", text: "答案", streaming: false };
  /** 整轮结束的信号：过程组只在它到达时收起。 */
  const done: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 };
  const turn = [thinking("这是思考首行"), read(), bash(), answer];

  it("标准模式：整段过程收成一行组头，每一步默认不展开", () => {
    render(<MessageList items={turn} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("标准模式：组头带上思考首行预览", () => {
    render(<MessageList items={turn} />);
    expect(screen.getByText("这是思考首行")).toBeInTheDocument();
  });

  it("简洁模式：只有摘要，不显示推理预览", () => {
    setProcessView("concise");
    render(<MessageList items={turn} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("这是思考首行")).toBeNull();
  });

  it("点组头能看到每一步（标准模式）", () => {
    render(<MessageList items={turn} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("/w/a.md")).toBeInTheDocument();
  });

  it("详细模式：运行中直接铺开每一步，中途写回复也不收，整轮结束才折回组头", () => {
    setProcessView("detailed");
    const { rerender } = render(<MessageList items={[thinking("思考中"), read(), bash()]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    // 过渡回复不结束这一轮：保持平铺，不出现组头（否则任务进行中会一跳一跳）。
    rerender(<MessageList items={[thinking("思考中"), read(), bash(), answer]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByText("已读取文件并执行了命令")).toBeNull();

    // result 到了才整段收起。
    rerender(<MessageList items={[thinking("思考中"), read(), bash(), answer, done]} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).toBeNull();
  });

  it("中途写回复不会让展开的组收起（只在整轮结束时收）", () => {
    const { rerender } = render(<MessageList items={[thinking("思考中"), read(), bash()]} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    // 过渡回复：组已经不是列表末尾，但这一轮还在跑——不能收，否则任务中会反复折叠。
    rerender(<MessageList items={[thinking("思考中"), read(), bash(), answer]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    // 组自己的内容结束了，组头换成完成摘要。
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();

    rerender(<MessageList items={[thinking("思考中"), read(), bash(), answer, done]} />);
    expect(screen.queryByText("ls -la")).toBeNull();
  });

  it("标准模式：手动展开的组在这一轮结束时自动收起", () => {
    const live = [thinking("思考中"), read(), bash()];
    const { rerender } = render(<MessageList items={live} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    rerender(<MessageList items={[...live, answer, done]} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).toBeNull();
  });

  it("单独一步不成组：直接显示那一行，省一次点击", () => {
    render(<MessageList items={[bash(), answer]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByText("执行了命令")).toBeNull();
  });

  it("详细模式：单独的工具仍是完整卡片（留作回退）", () => {
    setProcessView("detailed");
    render(<MessageList items={[bash(), answer]} />);
    expect(screen.getByText("输出")).toBeInTheDocument();
  });

  it("行内始终有可展开入口：紧凑行不是死行（点击能看到输出）", () => {
    render(<MessageList items={[bash(), answer]} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("输出")).toBeInTheDocument();
  });
});

// 转录回放里没有 result 行（claude 只把它写 stdout）：只看「后面有没有 result」
// 会把所有历史轮次判成还在跑，详细模式下整段历史被平铺展开、组头永远写「进行中」。
describe("MessageList 回放历史", () => {
  const read: Item = {
    id: "t1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Read",
    input: { file_path: "/w/a.md" },
    result: "内容",
  };
  const bash: Item = {
    id: "t2",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu2",
    name: "Bash",
    input: { command: "ls -la" },
    result: "a",
  };
  const answer: Item = { id: "a1", seq: 0, ts: 0, kind: "assistant", text: "答案", streaming: false };

  it("会话空闲时，没有 result 的历史过程组也按已完成收起", () => {
    setProcessView("detailed");
    setSessionRunning(false);
    render(<MessageList items={[read, bash, answer]} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).toBeNull();
  });

  it("会话在跑时，同样的列表按运行中处理", () => {
    setProcessView("detailed");
    setSessionRunning(true);
    render(<MessageList items={[read, bash, answer]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });
});

describe("MessageList 收起时机", () => {
  beforeEach(() => setSessionRunning(true));
  const thinking = (): Item => ({ id: "th1", seq: 0, ts: 0, kind: "thinking", text: "思考中" });
  const read = (): Item => ({
    id: "t1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Read",
    input: { file_path: "/w/a.md" },
    result: "内容",
  });
  const bash = (): Item => ({
    id: "t2",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu2",
    name: "Bash",
    input: { command: "ls -la" },
    result: "a",
  });
  const answer: Item = { id: "a1", seq: 0, ts: 0, kind: "assistant", text: "答案", streaming: false };
  const nextUser: Item = { id: "u2", seq: 0, ts: 0, kind: "user", text: "下一条" };
  const done: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 };

  it("下次发送时收起：整轮结束后过程仍然展开", () => {
    setCollapseTiming("onNextSend");
    render(<MessageList items={[thinking(), read(), bash(), answer, done]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("/w/a.md")).toBeInTheDocument();
  });

  it("下次发送时收起：发出下一条消息才折回一行", () => {
    setCollapseTiming("onNextSend");
    const { rerender } = render(<MessageList items={[thinking(), read(), bash(), answer, done]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    rerender(<MessageList items={[thinking(), read(), bash(), answer, done, nextUser]} />);
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
  });

  it("下次发送时收起：详细模式保留平铺过程行（不冒出组头）", () => {
    setProcessView("detailed");
    setCollapseTiming("onNextSend");
    render(<MessageList items={[thinking(), read(), bash(), answer, done]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByText("已读取文件并执行了命令")).toBeNull();
  });

  it("完成时收起：整轮结束就折回一行（对照）", () => {
    render(<MessageList items={[thinking(), read(), bash(), answer, done]} />);
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
  });
});

describe("MessageList 收起后的回复", () => {
  const user = (): Item => ({ id: "u1", seq: 0, ts: 0, kind: "user", text: "问题" });
  const stage: Item = { id: "a1", seq: 0, ts: 0, kind: "assistant", text: "阶段回复", streaming: false };
  const read: Item = {
    id: "t1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Read",
    input: { file_path: "/w/a.md" },
    result: "x",
  };
  const final: Item = { id: "a2", seq: 0, ts: 0, kind: "assistant", text: "最终答案", streaming: false };
  const bash: Item = {
    id: "t2",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu2",
    name: "Bash",
    input: { command: "ls" },
    result: "y",
  };
  const result: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 };

  it("仅最终回答：已结束的轮次只留最后一条回答", () => {
    setFoldedReplies("final");
    render(<MessageList items={[user(), stage, read, bash, final, result]} />);
    expect(screen.queryByText("阶段回复")).toBeNull();
    expect(screen.getByText("最终答案")).toBeInTheDocument();
  });

  it("全部回复：阶段回复照常可见（默认）", () => {
    render(<MessageList items={[user(), stage, read, bash, final, result]} />);
    expect(screen.getByText("阶段回复")).toBeInTheDocument();
    expect(screen.getByText("最终答案")).toBeInTheDocument();
  });

  it("仍有过程在跑时，阶段回复不消失", () => {
    setFoldedReplies("final");
    setSessionRunning(true);
    render(<MessageList items={[user(), stage, read, bash]} />);
    expect(screen.getByText("阶段回复")).toBeInTheDocument();
  });

  it("下次发送时收起：最新一轮完成后阶段回复仍然保留，发下一条才隐去", () => {
    setFoldedReplies("final");
    setCollapseTiming("onNextSend");
    const items = [user(), stage, read, bash, final, result];
    const { rerender } = render(<MessageList items={items} />);
    expect(screen.getByText("阶段回复")).toBeInTheDocument();

    rerender(<MessageList items={[...items, { id: "u2", seq: 0, ts: 0, kind: "user", text: "下一问" }]} />);
    expect(screen.queryByText("阶段回复")).toBeNull();
    expect(screen.getByText("最终答案")).toBeInTheDocument();
  });
});

describe("成功回合的结尾", () => {
  it("不再单独挂一个耗时胶囊（耗时已经在回答下面那一行）", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "问题" },
      { id: "a1", seq: 0, ts: 0, kind: "assistant", text: "答案", streaming: false },
      { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 },
    ];
    const { container } = render(<MessageList items={items} />);
    expect(container.textContent).not.toContain("9.0s");
  });
});

describe("被中断的回合", () => {
  it("中断标记渲染成一句「已中断」，不是一条用户消息", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "来点新闻" },
      { id: "a1", seq: 1, ts: 0, kind: "assistant", text: "半截回答", streaming: false },
      { id: "i1", seq: 2, ts: 0, kind: "interrupt", marker: "[Request interrupted by user]", reason: "user" },
      { id: "r1", seq: 3, ts: 0, kind: "result", isError: false, subtype: "interrupt" },
    ];
    const { container } = render(<MessageList items={items} />);
    expect(screen.getByText("已中断")).toBeInTheDocument();
    // CLI 的原始标记不露出来，也不再有第二条用户气泡。
    expect(container.textContent).not.toContain("Request interrupted");
    expect(screen.getAllByText(/来点新闻/)).toHaveLength(1);
    // 中断不是失败：不出现「本轮出错」。
    expect(screen.queryByText("本轮出错")).toBeNull();
  });

  // 进程/会话被结束（重启、被回收）不是用户按的停止：恢复对话时 CLI 补写另一条标记。
  it("会话被动结束说「本轮未完成」，不说「已中断」", () => {
    const items: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "跑一下测试" },
      {
        id: "i1",
        seq: 1,
        ts: 0,
        kind: "interrupt",
        marker: "[Request interrupted: the session ended before this agent finished.]",
        reason: "session",
      },
    ];
    render(<MessageList items={items} />);
    expect(screen.getByText("会话已结束，本轮未完成")).toBeInTheDocument();
    expect(screen.queryByText("已中断")).toBeNull();
  });
});
