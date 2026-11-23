import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { Item } from "../../lib/model";
import {
  resetCollapseTimingCache,
  resetFoldedRepliesCache,
  resetProcessViewCache,
  setCollapseTiming,
  setFoldedReplies,
  setProcessView,
} from "../../lib/viewMode";
import { useAppStore } from "../../store/useAppStore";

/**
 * 展开折叠块（思考过程 / 工具卡片）后要能继续贴底跟随。
 *
 * 跟随由 ResizeObserver 驱动：真浏览器里展开会让内容变高，这里用桩手动触发一次回调
 * 模拟「内容变高」，再断言滚动位置。规则只有一条——贴着底就跟、往上划过就不跟。
 */
let roCallbacks: ResizeObserverCallback[] = [];

function stubResizeObserver() {
  roCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        roCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

function raf() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** 让所有观察器都报一次「尺寸变了」，并等跟随逻辑所在的 rAF 跑完。 */
async function fireResize() {
  for (const cb of roCallbacks) cb([], {} as ResizeObserver);
  await raf();
}

/** 内容变高：scrollHeight 跟着变大。 */
function grow(el: HTMLElement, scrollHeight: number) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
}

/** 挂载并放掉「初次贴底」那个 rAF，再按用户操作摆位置。 */
async function mountAndSettle(items: Item[]) {
  render(<MessageList items={items} />);
  const el = screen.getByTestId("message-scroller");
  Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
  await raf();
  return el;
}

beforeEach(() => {
  // 会话在跑，过程组才不会在挂载时按「已完成」收起。
  useAppStore.setState({ activeId: "s1", states: { s1: "busy" } });
  resetProcessViewCache();
  setProcessView("standard");
  resetCollapseTimingCache();
  setCollapseTiming("onComplete");
  resetFoldedRepliesCache();
  setFoldedReplies("all");
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const thinking: Item = {
  id: "th1",
  seq: 0,
  ts: 0,
  kind: "thinking",
  text: "先看看这份文件\n第二段",
};
const bash: Item = {
  id: "t2",
  seq: 1,
  ts: 0,
  kind: "tool",
  toolUseId: "tu2",
  name: "Bash",
  input: { command: "ls -la" },
  result: "a\nb\nc",
};
const answer: Item = { id: "a1", seq: 2, ts: 0, kind: "assistant", text: "答案", streaming: false };

describe("MessageList 展开后贴底跟随", () => {
  it("贴着底时，展开思考过程后继续跟到底部", async () => {
    const el = await mountAndSettle([thinking, answer]);
    // 初次跟随已经落到底：scrollTop = scrollHeight - clientHeight。
    el.scrollTop = 500;

    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    grow(el, 1400);
    await fireResize();

    expect(el.scrollTop).toBe(1400);
  });

  it("手动往上滑过就不再自动跟随（没有额外状态，只看方向）", async () => {
    const el = await mountAndSettle([thinking, answer]);
    // 先到底，再往上滚一次：贴底状态只认「往上滚」这个方向。
    el.scrollTop = 500;
    fireEvent.scroll(el);
    el.scrollTop = 200;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    grow(el, 1400);
    await fireResize();

    expect(el.scrollTop).toBe(200);
  });

  it("滚回底部后恢复自动跟随", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);
    el.scrollTop = 200;
    fireEvent.scroll(el);
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(200);

    // 往下滚回底部：scrollHeight - scrollTop - clientHeight = 0。
    el.scrollTop = 900;
    fireEvent.scroll(el);
    grow(el, 1600);
    await fireResize();

    expect(el.scrollTop).toBe(1600);
  });

  it("展开工具卡片同样跟随", async () => {
    const el = await mountAndSettle([bash, answer]);
    el.scrollTop = 500;

    fireEvent.click(screen.getByRole("button", { name: /运行命令|执行了命令/ }));
    grow(el, 1200);
    await fireResize();

    expect(el.scrollTop).toBe(1200);
  });

  // 回归（真实的「滚着滚着不跟了」）：跟随把 scrollTop 推到底之后，内容往往在
  // 下一个 scroll 事件被处理前又长高了一截。此时距底已经 > 100px，但用户并没有
  // 往上滚——按「距底多远」判会把跟随悄悄关掉。
  it("内容长高造成的距底变大不算「用户离开底部」", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;

    // 跟随把位置推到底（1400 - 500 = 900）。
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(1400);

    // 又长高了一大截，而 scrollTop 还停在旧位置：浏览器补发一次 scroll 事件。
    grow(el, 2000);
    fireEvent.scroll(el);

    // 仍然跟随：再长高时继续跟到底，不需要用户点按钮。
    grow(el, 2400);
    await fireResize();
    expect(el.scrollTop).toBe(2400);
  });
});

// 滚动区的高度不是固定的：输入区上方的审批卡片、任务清单、「少女祈祷中」计时行
// 出现/消失都会挤占它。高度一变，scrollTop 停在原处就不再是最底部（内容没动、视口
// 变矮了），于是「回到底部」按钮自己冒出来、还带个「有新内容」的圆点。
describe("MessageList 容器尺寸变化后贴底", () => {
  /** 视口变高/变矮（内容不变）。jsdom 不会替我们 clamp scrollTop，这里要自己按几何摆。 */
  function resizeViewport(el: HTMLElement, clientHeight: number) {
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  }

  it("贴底时容器变矮（审批卡片/计时行挤进来）会重新贴到底", async () => {
    const el = await mountAndSettle([thinking, answer]);
    grow(el, 1000);
    // 内容 1000、视口 500：贴底是 scrollTop = 500。
    el.scrollTop = 500;
    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();

    // 视口矮成 300（卡片挤进来 200px）：新的底部是 700，停在 500 就不再贴底。
    resizeViewport(el, 300);
    await fireResize();

    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();
  });

  // 卡片消失、容器变高时同理：贴底状态下视口长高了，位置也要跟到新的底部。
  it("贴底时容器变高（卡片消失）同样跟到底", async () => {
    const el = await mountAndSettle([thinking, answer]);
    grow(el, 1000);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    resizeViewport(el, 800);
    await fireResize();

    // 代码写的是 scrollTop = scrollHeight（内容 1000）；真浏览器会自己夹到
    // 1000-800=200。jsdom 不 clamp，所以这里只断言「往新的底部去了」。
    expect(el.scrollTop).toBeGreaterThanOrEqual(200);
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();
  });

  // 反过来：用户已经往上翻过，容器尺寸变化不该把他拽回底部。
  it("用户往上翻过就不动：尺寸变化不抢滚动位置", async () => {
    const el = await mountAndSettle([thinking, answer]);
    grow(el, 1000);
    el.scrollTop = 500;
    fireEvent.scroll(el);
    el.scrollTop = 200;
    fireEvent.scroll(el);

    resizeViewport(el, 300);
    await fireResize();

    expect(el.scrollTop).toBe(200);
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });
});

// 别的设备/标签发的消息（后端 `prompt.echo` 补进来的）不是「我刚发的」：
// 往上翻着读历史时被拽回底部，正是注释里说「仍然遵守往上翻就停下」要避免的。
describe("MessageList 别人发的消息不抢滚动位置", () => {
  async function mountScrolled(items: Item[]) {
    const { rerender } = render(<MessageList items={items} resetKey="k" />);
    const el = screen.getByTestId("message-scroller");
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 1500, writable: true, configurable: true });
    await raf();
    // 往上翻着读历史。
    el.scrollTop = 100;
    fireEvent.scroll(el);
    return { el, rerender };
  }

  it("往上翻着读历史时来了 echo：位置不动", async () => {
    const { el, rerender } = await mountScrolled([thinking, answer]);
    const echo: Item = { id: "u-echo", seq: 3, ts: 0, kind: "user", text: "别人的消息", echoed: true };
    rerender(<MessageList items={[thinking, answer, echo]} resetKey="k" />);
    expect(el.scrollTop).toBe(100);
  });

  it("自己发的仍然强制回到底部", async () => {
    const { el, rerender } = await mountScrolled([thinking, answer]);
    const mine: Item = { id: "u-mine", seq: 3, ts: 0, kind: "user", text: "我刚发的" };
    rerender(<MessageList items={[thinking, answer, mine]} resetKey="k" />);
    expect(el.scrollTop).toBe(2000);
  });
});

// 右侧栏轨迹点某一步 = 「我要看这一条」。从那一刻起不该再贴底跟随，否则下一帧流式
// 内容长高（或任何一次尺寸变化）会立刻把视口拽回底部——用户看到的是「跳过去闪一下
// 又弹回最新」，那颗点击等于白点。
describe("轨迹跳转后的跟随", () => {
  const firstUser: Item = { id: "u0", seq: 0, ts: 0, kind: "user", text: "跑一下" };
  const firstAnswer: Item = { id: "a0", seq: 1, ts: 0, kind: "assistant", text: "好了", streaming: false };
  const secondUser: Item = { id: "u1", seq: 2, ts: 0, kind: "user", text: "再来" };
  const secondAnswer: Item = { id: "a1", seq: 3, ts: 0, kind: "assistant", text: "又好了", streaming: false };

  it("跳到中间某条之后，内容继续长高也不会把视口拽回底部", async () => {
    render(
      <MessageList items={[firstUser, firstAnswer, secondUser, secondAnswer]} resetKey="jump-follow" />,
    );
    const el = screen.getByTestId("message-scroller");
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    // jsdom 不会像浏览器那样把 scrollTop 夹到 scrollHeight - clientHeight：
    // 自己补上，否则「钉到底部」写进去的 2000 会让后面的落点算错。
    let top = 0;
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, 2000 - 500));
      },
      configurable: true,
    });
    await raf();
    el.scrollTop = 1500;
    fireEvent.scroll(el);

    // jsdom 没有真实几何：把目标摆在视口上方 400px（1500 - 400 - 8 = 1092）。
    const target = el.querySelector<HTMLElement>('[data-item-id="a0"]');
    expect(target).not.toBeNull();
    vi.spyOn(target!, "getBoundingClientRect").mockReturnValue({ top: -400 } as DOMRect);
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);

    useAppStore.setState({ scrollRequest: null });
    act(() => useAppStore.getState().requestScrollToItem("a0"));
    await raf();
    expect(el.scrollTop).toBe(1092);

    // 内容继续长高：跟随不能把它拽回底部（2400）。
    grow(el, 2400);
    await fireResize();
    expect(el.scrollTop).toBe(1092);
  });
});

// 手机上长按选文本 / 按住屏幕读一段话时内容还在流式增长：跟随会在手指底下继续推，
// 选中直接跑掉。按住期间只暂停，松手没动过就恢复（轻点一下不该让会话从此不跟随）。
describe("按住屏幕期间暂停跟随", () => {
  it("按住时不推内容，松手后贴回底部", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    fireEvent.pointerDown(el, { clientY: 100 });
    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(500);

    fireEvent.pointerUp(el, { clientY: 100 });
    expect(el.scrollTop).toBe(1400);
  });

  it("按住后拖动过（读者在滚）就不恢复跟随", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    fireEvent.pointerDown(el, { clientY: 300 });
    fireEvent.pointerMove(el, { clientY: 240 });
    el.scrollTop = 200;
    fireEvent.scroll(el);
    fireEvent.pointerUp(el, { clientY: 240 });

    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(200);
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });

  it("滚轮往上滚立刻解除跟随（不必等 scroll 事件）", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();

    fireEvent.wheel(el, { deltaY: -40 });
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });
  it("嵌套滚动区（代码块）里的滚轮不动跟随", async () => {
    const el = await mountAndSettle([bash, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);
    // 工具卡片里的命令块：滚的是它自己，读者并没有离开会话底部。
    const nested = document.createElement("pre");
    nested.className = "code-scroll";
    el.appendChild(nested);

    fireEvent.wheel(nested, { deltaY: -40 });
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();
    nested.remove();
  });
});

// 不贴底时收起一段内容（一轮结束把过程折起来、折叠一张卡片），浏览器会按新的
// scrollHeight 重排；读者正在看的那一行必须留在原来的屏幕位置，否则「点一下收起，
// 正文跳一段」，人得重新找读到哪儿了。
describe("内容变短时钉住读者视线", () => {
  const q1: Item = { id: "q1", seq: 0, ts: 0, kind: "user", text: "问题" };
  const r1: Item = { id: "r1", seq: 1, ts: 0, kind: "assistant", text: "回答一", streaming: false };
  const q2: Item = { id: "q2", seq: 2, ts: 0, kind: "user", text: "再问" };
  const r2: Item = { id: "r2", seq: 3, ts: 0, kind: "assistant", text: "回答二", streaming: false };
  const items = [q1, r1, q2, r2];

  /** jsdom 没有布局：按给定的「行顶/行底」摆位置，滚动区自身顶在 0。 */
  function place(el: HTMLElement, table: Record<string, [number, number]>) {
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ top: 0 } as DOMRect),
      configurable: true,
    });
    for (const [id, [top, bottom]] of Object.entries(table)) {
      const row = el.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
      if (!row) continue;
      Object.defineProperty(row, "getBoundingClientRect", {
        value: () => ({ top, bottom } as DOMRect),
        configurable: true,
      });
    }
  }

  it("收起一段内容后，读者正在看的那一行还在原位", async () => {
    const { rerender } = render(<MessageList items={items} resetKey="anchor" />);
    const el = screen.getByTestId("message-scroller");
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 800, writable: true, configurable: true });

    // 视口顶（scrollTop=800）落在 q2 与 r2 的交界：r2 是第一条越过视口顶的行。
    place(el, { q1: [-800, -700], r1: [-700, -600], q2: [-600, 0], r2: [0, 400] });
    // 一次同长度的新数组：让 layout effect 记下内容高度（2000）。
    rerender(<MessageList items={[...items]} resetKey="anchor" />);

    el.scrollTop = 800;
    fireEvent.scroll(el); // 读者在中间：跟随解除
    // 停手 150ms 后才刷新锚点（见 onScroll 的 settle）。
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // 内容变短 400px：r2 上方少了一段，它的顶部上移到 -400。
    Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
    place(el, { q1: [-800, -700], r1: [-700, -600], q2: [-600, 0], r2: [-400, 0] });
    rerender(<MessageList items={[...items]} resetKey="anchor" />);

    // 视线钉在 r2 的顶部：scrollTop 跟着少 400，而不是停在 800 让正文跳走。
    expect(el.scrollTop).toBe(400);
  });
});

// 触摸滚动一开始（滚动交给 compositor）、以及长按选择手势，浏览器都会发
// `pointercancel` 并且**不再补 `pointerup`**；手指真正离开屏幕是 `touchend`。
//
// 曾经把 `pointercancel` 当松手：那一刻 `press` 被清空，而 `press` 正是三条贴底写入
// （items 的 layout effect、内容 ResizeObserver、容器 ResizeObserver）唯一的守卫——
// 于是在整段滚动过程中，流式思考每长高一帧就把 `scrollTop` 写回底部，手指每滑几像素
// 就被拽回去；`onScroll` 的归因又因为落点落在 24px 容差内把 `following` 判回 true，
// 越滚越回底。手机上表现就是「消息一直往底部撤回、抖」，只有使劲一甩才滚得动。
describe("触摸滚动期间 pointercancel 不结束手势", () => {
  // **这是这次问题的核心回归**：触摸滚动每帧只动几像素，而流式思考每帧都在长高。
  // 只要 `press` 在滚动途中被清掉，三条贴底守卫就全失效——内容每长高一帧就把视口写回
  // 底部，手指的几像素位移被吃掉；`onScroll` 的归因又因为落点落在 24px 容差内把
  // `following` 判回 true，于是越滚越回底，只有一帧滑过 24px 才滚得动。
  it("手指缓慢上滑的整段过程中，视口始终停在手指的位置", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    fireEvent.pointerDown(el, { clientY: 400, pointerType: "touch" });
    // 真实浏览器：触摸滚动一开始就把 pointer 收走（滚动交给 compositor），
    // 之后只有 `scroll` 事件，没有 `pointermove`，直到 `touchend`。
    fireEvent.pointerCancel(el, { clientY: 400 });

    let height = 1000;
    let top = 500;
    for (let i = 0; i < 10; i += 1) {
      // 一帧：内容长高 8px（流式思考），手指向上滑 6px。
      height += 8;
      top -= 6;
      grow(el, height);
      await fireResize();
      el.scrollTop = top;
      fireEvent.scroll(el);
    }

    // 视口停在手指的位置，没有被贴底跟随吃掉。
    expect(el.scrollTop).toBe(top);
    // 手势还没结束：此刻仍不该出现「回到底部」。
    expect(screen.queryByRole("button", { name: /回到底部/ })).toBeNull();

    fireEvent.touchEnd(el);
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });

  it("pointercancel 之后内容长高也不把视口拽回底部", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    // 手指按上去、开始滑动：浏览器把 pointer 收走（滚动转交 compositor）。
    fireEvent.pointerDown(el, { clientY: 400, pointerType: "touch" });
    fireEvent.pointerCancel(el, { clientY: 400 });

    // 手势还没结束：贴底写入必须继续被暂停，内容长高不影响视口。
    el.scrollTop = 420;
    fireEvent.scroll(el);
    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(420);
  });

  it("touchend 之后才结算：手指划过就停止跟随，出现「回到底部」", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    fireEvent.pointerDown(el, { clientY: 400, pointerType: "touch" });
    fireEvent.pointerCancel(el, { clientY: 400 });
    el.scrollTop = 300;
    fireEvent.scroll(el);

    // 手指离开屏幕：结算成「读者往上滚过」，从此不跟。
    fireEvent.touchEnd(el);
    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(300);
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });

  it("touchend 时已经真回到最底部则恢复跟随", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    fireEvent.pointerDown(el, { clientY: 400, pointerType: "touch" });
    fireEvent.pointerCancel(el, { clientY: 400 });
    // 内容 1000 / 视口 500：贴底就是 500。
    el.scrollTop = 500;
    fireEvent.scroll(el);
    fireEvent.touchEnd(el);

    grow(el, 1600);
    await fireResize();
    expect(el.scrollTop).toBe(1600);
  });

  it("鼠标（非 touch）松手仍按 pointerup 结算", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    // 鼠标拖选文本：pointerup 就来（没有 touchend）。
    fireEvent.pointerDown(el, { clientY: 100, pointerType: "mouse" });
    fireEvent.pointerUp(window);
    grow(el, 1400);
    await fireResize();
    // 没动过 → 恢复跟随并贴底。
    expect(el.scrollTop).toBe(1400);
  });

  it("touchend 没到达时由 10 秒兜底结算，跟随不会永久停摆", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    // 只把 set/clearTimeout 换成假时钟：`requestAnimationFrame` 必须保持真实，
    // 否则 `mountAndSettle` / `fireResize` 等不到那一帧。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.pointerDown(el, { clientY: 400, pointerType: "touch" });
      // 手指没离开、touchend 也没来（WebView 吞事件）。
      el.scrollTop = 300;
      fireEvent.scroll(el);
      act(() => vi.advanceTimersByTime(10_000));
    } finally {
      vi.useRealTimers();
    }

    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(300);
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });
});

// 松手可能发生在滚动区外（拖出去再松开），也可能收不到 pointerup（移动端滚动换成
// pointercancel）。漏一次 press 就永远清不掉，跟随再也回不来。
describe("松手兜底", () => {
  it("在滚动区外松手也能恢复跟随", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);

    fireEvent.pointerDown(el, { clientY: 100 });
    grow(el, 1400);
    await fireResize();
    expect(el.scrollTop).toBe(500);

    fireEvent.pointerUp(window);
    expect(el.scrollTop).toBe(1400);
  });

  it("正文元素上的滚轮仍然解除跟随（不能被当成嵌套滚动）", async () => {
    const el = await mountAndSettle([thinking, answer]);
    el.scrollTop = 500;
    fireEvent.scroll(el);
    const body = screen.getByText("答案");
    fireEvent.wheel(body, { deltaY: -40 });
    expect(screen.getByRole("button", { name: /回到底部/ })).toBeInTheDocument();
  });
});
