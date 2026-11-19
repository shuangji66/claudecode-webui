import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProcessGroup } from "./ProcessGroup";
import type { Item } from "../../lib/model";

/**
 * 过程组正文是「页面里再套一个限高滚动区」（md 以上 max-h 400px）：
 * 展开组里的某一步时，新露出来的内容同样要跟着往下走，否则点开像没反应。
 *
 * 这里只测「跟随」这一条规则：贴着底就跟，往上划过就不跟。
 */
let roCallbacks: ResizeObserverCallback[] = [];

function raf() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function fireResize() {
  for (const cb of roCallbacks) cb([], {} as ResizeObserver);
  await raf();
}

/** 等 ResizeObserver 挂上（effect 在挂载后才跑）。 */
async function mounted() {
  await raf();
}

const items: Item[] = [
  { id: "th1", seq: 0, ts: 0, kind: "thinking", text: "思考一下" },
  {
    id: "t1",
    seq: 1,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Bash",
    input: { command: "ls" },
    result: "a",
  },
];

beforeEach(() => {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function body(): HTMLElement {
  // 组正文：组头按钮之后的那个 div（里面裹着内容和 children）。
  const el = document.querySelector<HTMLElement>("[data-testid='process-body']");
  if (!el) throw new Error("process body not found");
  return el;
}

function sizeBody(el: HTMLElement, scrollHeight: number, clientHeight = 200, scrollTop = 0) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
}

const renderGroup = (children: React.ReactNode) =>
  render(
    <ProcessGroup items={items} live atTail={false} view="standard">
      {children}
    </ProcessGroup>,
  );

describe("ProcessGroup 展开后贴底跟随", () => {
  it("组正文贴着底时，展开里面的步骤继续跟随", async () => {
    renderGroup(<p>一步</p>);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await mounted();

    const el = body();
    // 贴底：scrollHeight - scrollTop - clientHeight = 0
    sizeBody(el, 800, 200, 600);
    fireEvent.scroll(el);

    // 展开里面的内容 → 正文变高
    sizeBody(el, 1000, 200, 600);
    await fireResize();

    expect(el.scrollTop).toBe(1000);
  });

  it("组正文被往上划过就不跟（滑回底部再恢复）", async () => {
    renderGroup(<p>一步</p>);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await mounted();

    const el = body();
    sizeBody(el, 800, 200, 100);
    fireEvent.scroll(el);

    sizeBody(el, 1000, 200, 100);
    await fireResize();
    expect(el.scrollTop).toBe(100);

    // 滑回底部：scrollHeight - scrollTop - clientHeight = 0
    sizeBody(el, 1000, 200, 800);
    fireEvent.scroll(el);
    sizeBody(el, 1200, 200, 800);
    await fireResize();
    expect(el.scrollTop).toBe(1200);
  });
});
