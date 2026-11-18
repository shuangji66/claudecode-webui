import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { Item } from "../../lib/model";
import { resetProcessViewCache, setProcessView } from "../../lib/viewMode";

beforeEach(() => {
  // 过程展示偏好存在模块缓存里：每个用例从默认的「标准」开始。
  resetProcessViewCache();
  setProcessView("standard");
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
    expect(screen.getAllByText("5.0s")).toHaveLength(1);
  });
});

describe("MessageList 过程展示", () => {
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

  it("详细模式：运行中直接铺开每一步，回答一到自动收成组头", () => {
    setProcessView("detailed");
    const { rerender } = render(<MessageList items={[thinking("思考中"), read(), bash()]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByText("已读取文件并执行了命令")).toBeNull();

    rerender(<MessageList items={[thinking("思考中"), read(), bash(), answer]} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).toBeNull();
  });

  it("标准模式：手动展开的组在回答到达时自动收起", () => {
    const live = [thinking("思考中"), read(), bash()];
    const { rerender } = render(<MessageList items={live} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    rerender(<MessageList items={[...live, answer]} />);
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
