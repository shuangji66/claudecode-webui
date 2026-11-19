import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("button", { name: /Bash|执行了命令/ }));
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
