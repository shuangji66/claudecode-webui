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
function assistantItem(i: number): Item {
  return { id: `a${i}`, seq: i, ts: 0, kind: "assistant", text: `回复 ${i}`, streaming: false };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => userItem(i));

/** jsdom 里滚动几何全是 0：按需给元素补上可测的尺寸。 */
function sizedScroller(scrollHeight = 1000, clientHeight = 500) {
  const el = screen.getByTestId("message-scroller");
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTo", { value: vi.fn(), configurable: true });
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
  return el as HTMLElement;
}

/**
 * 模拟用户往上滚：贴底状态只看**滚动方向**（往上滚 = 要离开底部），
 * 所以必须真的造出一次 scrollTop 变小的过程，单次事件不算。
 */
function scrollUp(el: HTMLElement, to = 0) {
  el.scrollTop = 1000 - 500; // 先到底
  fireEvent.scroll(el);
  el.scrollTop = to;
  fireEvent.scroll(el);
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

  // 回归：一轮的过程（工具调用）轻易超过 80 条，按条数硬切会把这一轮的
  // 用户消息整个切出去——界面上只剩「正在分析请求」，用户以为刚发的话丢了。
  it("长过程的那一轮：用户消息必须还在窗口里", () => {
    const items: Item[] = [{ id: "keep", seq: 0, ts: 0, kind: "user", text: "这一轮的问题" }];
    for (let i = 0; i < 200; i += 1) {
      items.push({ id: `t${i}`, seq: i + 1, ts: 0, kind: "tool", toolUseId: `tu${i}`, name: "Bash", input: {} } as Item);
    }
    render(<MessageList items={items} />);
    expect(screen.getByText("这一轮的问题")).toBeInTheDocument();
    // 整轮都在窗口里，没有「加载更早」的入口。
    expect(screen.queryByRole("button", { name: /加载更早/ })).toBeNull();
  });

  it("往上翻时出现回到底部按钮，点击后消失", () => {
    render(<MessageList items={many(5)} />);
    const el = sizedScroller();

    // 往上滚 = 要离开底部（贴底与否只看方向，不看距底多远）
    scrollUp(el);
    const fab = screen.getByRole("button", { name: "回到底部" });
    expect(fab).toBeInTheDocument();

    fireEvent.click(fab);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });

  it("不贴底时来了新消息，按钮提示「有新内容」", () => {
    const { rerender } = render(<MessageList items={many(5)} />);
    const el = sizedScroller();
    scrollUp(el);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeInTheDocument();

    // 不是自己发的（别的设备 / 回复），所以只点亮提示，不抢滚动位置。
    rerender(<MessageList items={[...many(5), userItem(99), assistantItem(100)]} />);
    expect(screen.getByRole("button", { name: "有新内容，回到底部" })).toBeInTheDocument();
  });

  // 用户往上翻着读历史、直接发一句话：必须立刻回到底部并恢复跟随，
  // 否则自己刚发的气泡与后面的回复全在视口外，看起来像「发了没反应」。
  it("自己发消息时强行回到底部并恢复跟随", () => {
    const { rerender } = render(<MessageList items={many(5)} />);
    const el = sizedScroller();
    scrollUp(el);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeInTheDocument();

    rerender(<MessageList items={[...many(5), userItem(99)]} />);
    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();
  });

  it("自己发消息之后，后续的回复继续贴底跟随", async () => {
    const { rerender } = render(<MessageList items={many(5)} />);
    const el = sizedScroller();
    scrollUp(el);

    rerender(<MessageList items={[...many(5), userItem(99)]} />);
    // 回复进来时内容变高，跟随着喂到新的底部（跟随写在 rAF 里，等一帧）。
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    rerender(<MessageList items={[...many(5), userItem(99), assistantItem(100)]} />);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(el.scrollTop).toBe(2000);
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

  // 回归：滚到底时视口顶部还停在最后一条回答的开头（一轮的末尾可能就是整屏），
  // 按「视口顶部落在哪一轮」算会一直亮着倒数第二轮。
  it("滚到底时刻度高亮最后一轮", async () => {
    render(<MessageList items={conversation(3)} />);
    const el = sizedScroller();
    // 先往上滚（刻度跟位置走），再滚回底部。
    scrollUp(el);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(screen.getByRole("button", { name: /跳到第 1 轮/ })).toHaveAttribute("aria-current", "true");

    el.scrollTop = 500; // scrollHeight - clientHeight = 500，到底
    fireEvent.scroll(el);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(screen.getByRole("button", { name: /跳到第 3 轮/ })).toHaveAttribute("aria-current", "true");
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

describe("MessageList 复制入口", () => {
  // 一轮里模型会写好几段过渡正文（夹在思考与工具调用之间）：只给最终回答一个复制按钮。
  const user = (): Item => ({ id: "u1", seq: 0, ts: 0, kind: "user", text: "问题" });
  const stage = (text: string): Item => ({ id: "a1", seq: 0, ts: 0, kind: "assistant", text, streaming: false });
  const final = (text: string): Item => ({ id: "a2", seq: 0, ts: 0, kind: "assistant", text, streaming: false });
  const thinking = (): Item => ({ id: "th1", seq: 0, ts: 0, kind: "thinking", text: "推理内容" });
  const bash: Item = {
    id: "t1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Bash",
    input: { command: "ls" },
    result: "a",
  };
  const done: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 };

  it("过渡正文没有复制按钮，只有最终回答有", () => {
    setSessionRunning(false);
    setProcessView("detailed");
    render(<MessageList items={[user(), stage("先看看目录"), thinking(), bash, final("改好了"), done]} />);
    expect(screen.getAllByRole("button", { name: "复制回复" })).toHaveLength(1);
  });

  it("对话进行中不渲染复制按钮：那时最后一条正文只是半句话", () => {
    setSessionRunning(true);
    setProcessView("detailed");
    render(<MessageList items={[user(), stage("先看看目录"), thinking(), bash, final("改好了")]} />);
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
  });

  it("对话进行中，历史轮次的复制按钮照常有", () => {
    setSessionRunning(true);
    setProcessView("detailed");
    // 上一轮已结束（后面开了新一轮），当前这一轮还在跑。
    const prev: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "上一问" },
      { id: "p1", seq: 1, ts: 0, kind: "assistant", text: "上一答", streaming: false },
      { id: "pr1", seq: 2, ts: 0, kind: "result", durationMs: 3000 },
    ];
    const cur: Item[] = [
      { id: "u2", seq: 3, ts: 0, kind: "user", text: "这一问" },
      { id: "c1", seq: 4, ts: 0, kind: "assistant", text: "还没写完", streaming: false },
    ];
    render(<MessageList items={[...prev, ...cur]} />);
    expect(screen.getAllByRole("button", { name: "复制回复" })).toHaveLength(1);
  });

  it("收起态下复制入口仍在（过程都收起来了，答案还得能复制）", () => {
    setSessionRunning(false);
    render(<MessageList items={[user(), stage("先看看目录"), thinking(), bash, final("改好了"), done]} />);
    // 收起的是过程（思考与工具调用）；正文输出照留。
    expect(screen.queryByText("推理内容")).toBeNull();
    expect(screen.getByText("改好了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制回复" })).toBeInTheDocument();
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
  /** 整轮结束的信号：收起只在它（或会话空闲）之后发生。 */
  const done: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 };
  const user = (): Item => ({ id: "u1", seq: 0, ts: 0, kind: "user", text: "问题" });
  const turn = [user(), thinking("这是思考首行"), read(), bash(), answer];

  it("标准模式：不分组，每一步各占一行，工具操作折成一行", () => {
    setSessionRunning(true);
    render(<MessageList items={turn} />);
    // 没有组头：思考、Read、Bash 各自一行。
    expect(screen.queryByText("已读取文件并执行了命令")).toBeNull();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("标准模式：工具行不是死行，点开看正文", () => {
    setSessionRunning(true);
    render(<MessageList items={turn} />);
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("输出")).toBeInTheDocument();
  });

  it("简洁模式：连续的过程折成一行组头，默认收起", () => {
    setSessionRunning(true);
    setProcessView("concise");
    render(<MessageList items={turn} />);
    expect(screen.getByText("已读取文件并执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("详细模式：运行中直接铺开每一步的完整卡片", () => {
    setSessionRunning(true);
    setProcessView("detailed");
    render(<MessageList items={[user(), thinking("思考中"), bash(), answer]} />);
    // 卡片形态：命令直接铺在正文里，且带「输出」折叠块（紧凑行里要再点一层）。
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
  });

  it("正在跑的轮永远不收：整轮过程保持可见", () => {
    setSessionRunning(true);
    render(<MessageList items={turn} />);
    // 没有 result，也没有「已完成」那一行。
    expect(screen.queryByRole("button", { name: /已完成/ })).toBeNull();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("收起是轮级的：一轮结束就把整轮过程收起来，只留正文", () => {
    setSessionRunning(false);
    render(<MessageList items={[...turn, done]} />);
    // 过程（思考与工具）全都不见了，只剩用户消息、收起那一行与正文。
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.queryByText("/w/a.md")).toBeNull();
    expect(screen.queryByText("思考过程")).toBeNull();
    expect(screen.getByText("答案")).toBeInTheDocument();
    expect(screen.getByText("已完成，用时 00:09")).toBeInTheDocument();
  });

  // 放到轮首会跑到用户气泡上方：一进来先看见「已完成」会以为刚发的话被折没了。
  it("收起那一行在用户消息下方、回答上方", () => {
    setSessionRunning(false);
    const { container } = render(<MessageList items={[...turn, done]} />);
    const text = container.textContent ?? "";
    const userAt = text.indexOf("问题");
    const collapseAt = text.indexOf("已完成，用时");
    const answerAt = text.indexOf("答案");
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(collapseAt).toBeGreaterThan(userAt);
    expect(collapseAt).toBeLessThan(answerAt);
  });

  it("点开收起的那一行，过程按当前档位还原回原位", () => {
    setSessionRunning(false);
    render(<MessageList items={[...turn, done]} />);
    fireEvent.click(screen.getByRole("button", { name: /已完成/ }));
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("/w/a.md")).toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
  });

  it("点开之后不会被下一次渲染合回去", () => {
    setSessionRunning(false);
    const items = [...turn, done];
    const { rerender } = render(<MessageList items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /已完成/ }));
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    // 新内容到达（或父组件重渲染）不该改用户手动开合的那一轮。
    rerender(<MessageList items={[...items]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("没有过程可收的轮次不挂那一行（纯问答不该多一行）", () => {
    setSessionRunning(false);
    render(<MessageList items={[user(), answer, done]} />);
    expect(screen.queryByRole("button", { name: /已完成/ })).toBeNull();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("转录回放拿不到 result，也就给不出耗时：那一行只写「已完成」", () => {
    setSessionRunning(false);
    render(<MessageList items={[user(), thinking("思考中"), bash(), answer]} />);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText(/用时/)).toBeNull();
  });

  it("详细模式：单独的工具仍是完整卡片", () => {
    setSessionRunning(true);
    setProcessView("detailed");
    render(<MessageList items={[user(), bash(), answer]} />);
    expect(screen.getByText("输出")).toBeInTheDocument();
  });

  it("紧凑行始终有可展开入口：点开能看到输出", () => {
    setSessionRunning(true);
    render(<MessageList items={[user(), bash(), answer]} />);
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("输出")).toBeInTheDocument();
  });
});

// 转录回放里没有 result 行（claude 只把它写 stdout）：只看「后面有没有 result」
// 会把所有历史轮次判成还在跑，于是整段历史都不收起、也没有耗时。
describe("MessageList 回放历史", () => {
  const user: Item = { id: "u1", seq: 0, ts: 0, kind: "user", text: "问题" };
  const read: Item = {
    id: "t1",
    seq: 1,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Read",
    input: { file_path: "/w/a.md" },
    result: "内容",
  };
  const bash: Item = {
    id: "t2",
    seq: 2,
    ts: 0,
    kind: "tool",
    toolUseId: "tu2",
    name: "Bash",
    input: { command: "ls -la" },
    result: "a",
  };
  const answer: Item = { id: "a1", seq: 3, ts: 0, kind: "assistant", text: "答案", streaming: false };

  it("会话空闲时，没有 result 的历史轮次同样收起来", () => {
    setSessionRunning(false);
    render(<MessageList items={[user, read, bash, answer]} />);
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("会话在跑时，同样的列表按「还在进行中」处理：过程不收起", () => {
    setSessionRunning(true);
    render(<MessageList items={[user, read, bash, answer]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /已完成/ })).toBeNull();
  });
});

describe("MessageList 收起时机", () => {
  const user = (id: string): Item => ({ id, seq: 0, ts: 0, kind: "user", text: id });
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
  const done: Item = { id: "r1", seq: 0, ts: 0, kind: "result", durationMs: 9000 };

  it("下次发送时收起：整轮结束后过程仍然展开", () => {
    setCollapseTiming("onNextSend");
    setSessionRunning(false);
    render(<MessageList items={[user("u1"), thinking(), read(), bash(), answer, done]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("下次发送时收起：发出下一条消息才把它收起来", () => {
    setCollapseTiming("onNextSend");
    setSessionRunning(false);
    const items = [user("u1"), thinking(), read(), bash(), answer, done];
    const { rerender } = render(<MessageList items={items} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();

    // 新一轮开始：上一轮不再是最新的一轮，于是收起来。
    rerender(<MessageList items={[...items, user("u2")]} />);
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("已完成，用时 00:09")).toBeInTheDocument();
  });

  it("完成时收起：整轮结束就收（默认）", () => {
    setSessionRunning(false);
    render(<MessageList items={[user("u1"), thinking(), read(), bash(), answer, done]} />);
    expect(screen.queryByText("ls -la")).toBeNull();
    expect(screen.getByText("已完成，用时 00:09")).toBeInTheDocument();
  });

  // 会话正在跑最新一轮时，前面的轮次必然早已结束——它们的思考与工具不该跟着摊开。
  it("对话进行中，历史轮次照常收起，只有当前这一轮铺开", () => {
    setSessionRunning(true);
    const prev: Item[] = [
      { id: "u1", seq: 0, ts: 0, kind: "user", text: "上一问" },
      { id: "pth", seq: 1, ts: 0, kind: "thinking", text: "上一轮的思考" },
      { id: "p1", seq: 2, ts: 0, kind: "assistant", text: "上一答", streaming: false },
      { id: "pr1", seq: 3, ts: 0, kind: "result", durationMs: 3000 },
    ];
    const cur: Item[] = [
      { id: "u2", seq: 4, ts: 0, kind: "user", text: "这一问" },
      { id: "cth", seq: 5, ts: 0, kind: "thinking", text: "这一轮的思考" },
      { id: "c1", seq: 6, ts: 0, kind: "assistant", text: "还没写完", streaming: false },
    ];
    render(<MessageList items={[...prev, ...cur]} />);
    // 历史轮次的思考收起来了，当前这一轮的还在外面。
    expect(screen.queryByText("上一轮的思考")).toBeNull();
    expect(screen.getByText("这一轮的思考")).toBeInTheDocument();
  });

  it("跑到一半永远不收，哪怕选的是「完成时收起」", () => {
    setSessionRunning(true);
    render(<MessageList items={[user("u1"), thinking(), read(), bash(), answer]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
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
