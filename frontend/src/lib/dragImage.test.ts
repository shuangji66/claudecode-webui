import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDragPreview, startDragPreview } from "./dragImage";

function row(): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = "<button type='button'>会话甲</button>";
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  clearDragPreview();
  document.body.innerHTML = "";
});

describe("startDragPreview", () => {
  // 默认拖影是浏览器自己截的图，尺寸不受控（手机上会缩小）。这里断言我们交给
  // setDragImage 的是一块与行同宽同高的替身，而不是原件。
  it("给 setDragImage 一块与行同宽的离屏替身", () => {
    const el = row();
    el.getBoundingClientRect = () => ({ top: 20, left: 10, width: 240, height: 32, right: 250, bottom: 52, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;
    const setDragImage = vi.fn();
    const ok = startDragPreview({ setDragImage }, el, 30, 40);

    expect(ok).toBe(true);
    expect(setDragImage).toHaveBeenCalledTimes(1);
    const [node, dx, dy] = setDragImage.mock.calls[0] as [HTMLElement, number, number];
    expect(node).not.toBe(el);
    expect(node.style.width).toBe("240px");
    expect(node.style.height).toBe("32px");
    // 抓取点按「指针在行内的偏移」算，换成绝对坐标会让拖影跳到一边。
    expect([dx, dy]).toEqual([30 - 10, 40 - 20]);
    expect(node.textContent).toBe("会话甲");
    // 替身留在视口外，且不可交互。
    expect(node.style.left.startsWith("-")).toBe(true);
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(node.querySelector("button")!.tabIndex).toBe(-1);
  });

  it("clearDragPreview 把替身从 DOM 里摘掉", () => {
    const el = row();
    const setDragImage = vi.fn();
    startDragPreview({ setDragImage }, el, 0, 0);
    const node = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(document.body.contains(node)).toBe(true);

    clearDragPreview();
    expect(document.body.contains(node)).toBe(false);
  });

  // 有些 WebView 的 DataTransfer 没有 setDragImage：退回流默认拖影，别让排序报错。
  it("没有 setDragImage 时静默跳过", () => {
    const el = row();
    expect(startDragPreview({}, el, 0, 0)).toBe(false);
    expect(startDragPreview(null, el, 0, 0)).toBe(false);
    expect(document.querySelectorAll("body > div").length).toBe(1);
  });

  it("setDragImage 抛错时清掉替身并返回 false", () => {
    const el = row();
    const setDragImage = vi.fn(() => {
      throw new Error("unsupported");
    });
    expect(startDragPreview({ setDragImage }, el, 0, 0)).toBe(false);
    // 只剩原行，替身没有残留。
    expect(document.body.children).toHaveLength(1);
  });
});
