import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWheelScrollX } from "./wheelScroll";

/** jsdom 里 scrollWidth/clientWidth 恒为 0，必须自己钉住，否则「有没有溢出」的分支永远走不到。 */
function strip({ width, viewport }: { width: number; viewport: number }) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: viewport, configurable: true });
  document.body.appendChild(el);
  return el;
}

function mount(el: HTMLElement) {
  const ref = { current: el };
  return renderHook(() => useWheelScrollX(ref));
}

function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

describe("useWheelScrollX", () => {
  it("纵向滚轮换成横向滚动，并吃掉这次事件", () => {
    const el = strip({ width: 600, viewport: 200 });
    mount(el);
    const event = wheel(el, { deltaY: 40 });
    expect(el.scrollLeft).toBe(40);
    expect(event.defaultPrevented).toBe(true);
  });

  it("按行滚动的模式按行高换算（deltaMode=1）", () => {
    const el = strip({ width: 600, viewport: 200 });
    mount(el);
    wheel(el, { deltaY: 3, deltaMode: 1 });
    expect(el.scrollLeft).toBe(48);
  });

  it("已经到右边界的继续往前滚时放行，父级还能滚", () => {
    const el = strip({ width: 200, viewport: 200 });
    mount(el);
    const event = wheel(el, { deltaY: 40 });
    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("触控板的横向滑动不插手", () => {
    const el = strip({ width: 600, viewport: 200 });
    mount(el);
    const event = wheel(el, { deltaX: 40, deltaY: 0 });
    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  // 触控板几乎不会给纯纵向的事件：两个增量同时非零时接管，会把横向那一半
  // 与惯性一起吃掉，手感变成一顿一顿的。
  it("触控板斜着滑（deltaX 与 deltaY 同时非零）也不插手", () => {
    const el = strip({ width: 600, viewport: 200 });
    mount(el);
    const event = wheel(el, { deltaX: 30, deltaY: 5 });
    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("Ctrl + 滚轮是缩放，不能被抢去横向滚", () => {
    const el = strip({ width: 600, viewport: 200 });
    mount(el);
    const event = wheel(el, { deltaY: 40, ctrlKey: true });
    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("没有溢出时什么都不做", () => {
    const el = strip({ width: 200, viewport: 200 });
    mount(el);
    const event = wheel(el, { deltaY: 40 });
    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("卸载后不再响应滚轮", () => {
    const el = strip({ width: 600, viewport: 200 });
    const { unmount } = mount(el);
    unmount();
    const event = wheel(el, { deltaY: 40 });
    expect(el.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});
