import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { attachedPosition, Menu, useDismiss } from "./Menu";

/** 只给用得到的字段，其余补 0（jsdom 里所有 rect 都是 0，纯函数得自己造）。 */
function rect(partial: Partial<DOMRect>): DOMRect {
  const base = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const merged = { ...base, ...partial };
  return {
    ...merged,
    toJSON: () => merged,
  } as DOMRect;
}

describe("attachedPosition（添加菜单贴在输入卡上展开）", () => {
  it("宽度跟着输入卡、左边缘对齐，底边贴在卡片上沿", () => {
    // 手机竖屏：视口 390×844，输入卡 12~378、top 600。
    const pos = attachedPosition(rect({ left: 12, width: 366, top: 600, bottom: 700 }), 320);

    expect(pos.width).toBe(366);
    expect(pos.left).toBe(12);
    // 向上展开：用 bottom 锚定底边 = 视口高 - 卡片顶 + 4px 缝隙。
    expect(pos.bottom).toBe(window.innerHeight - 600 + 4);
    expect(pos.top).toBeUndefined();
  });

  it("卡片比视口还宽时收进视口留白里", () => {
    const pos = attachedPosition(rect({ left: 40, width: window.innerWidth + 200, top: 600 }), 320);

    expect(pos.width).toBe(window.innerWidth - 16);
    expect(pos.left).toBe(8);
  });

  it("高度上限只给通用上限的一半，别把整块对话区盖掉", () => {
    // jsdom 视口 768 高 → 通用上限 min(80vh, 560) = 560，一半是 280。
    const pos = attachedPosition(rect({ left: 12, width: 366, top: 600, bottom: 700 }), 2000);

    expect(pos.maxHeight).toBe(280);
  });

  it("上方空间比这一半还少时，按可用空间给（不压到表头上）", () => {
    // 卡片顶 200：200 - 4(缝隙) - 64(表头) = 132，比 280 少。
    const pos = attachedPosition(rect({ left: 12, width: 366, top: 200, bottom: 300 }), 2000);

    expect(pos.maxHeight).toBe(132);
  });

  it("上方确实塞不下、下方更宽裕时翻到卡片下面", () => {
    const pos = attachedPosition(rect({ left: 12, width: 366, top: 100, bottom: 200 }), 320);

    expect(pos.top).toBe(204);
    expect(pos.bottom).toBeUndefined();
  });
});

/** 只用来量 useDismiss 的触发次数：真实组件里 onClose 是 setState，重复调用看不出来。 */
function DismissProbe({ onClose }: { onClose: () => void }) {
  const layer = useRef<HTMLDivElement>(null);
  useDismiss(true, layer, null, onClose);
  return <div ref={layer}>layer</div>;
}

describe("useDismiss 的按下事件", () => {
  it("一次按下只关一次：pointerdown 之后合成的 mousedown 不再重复触发 onClose", () => {
    // 两个事件都注册时，浏览器的一次点击会先 pointerdown、再补一条兼容 mousedown，
    // onClose 被调两次；有副作用的关闭逻辑会跑两遍。
    const onClose = vi.fn();
    render(<DismissProbe onClose={onClose} />);

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("落在浮层里不关", () => {
    const onClose = vi.fn();
    const { getByText } = render(<DismissProbe onClose={onClose} />);

    fireEvent.pointerDown(getByText("layer"));

    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * 列表清空 / 触发器一起卸载的浮层（页头「后台操作」就是这样）。
 *
 * 触发元素游离之后 `getBoundingClientRect()` 全 0，align="end" 算出来的 left 是
 * 视口左边距——面板会飞到左上角；条目为空时还只剩一个 `p-1 + border` 的空框。
 */
function DynamicProbe({ n }: { n: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div>
      {n > 0 && (
        <button type="button" onClick={(e) => setAnchor(e.currentTarget)}>
          trigger
        </button>
      )}
      <Menu
        open={anchor !== null}
        anchor={anchor}
        items={Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `item ${i}`, onSelect: () => {} }))}
        onClose={() => setAnchor(null)}
      />
    </div>
  );
}

describe("Menu 在列表清空时收起来", () => {
  it("条目清空后不再留下空浮层", () => {
    const { container, rerender } = render(<DynamicProbe n={2} />);
    fireEvent.click(container.querySelector("button")!);
    // 浮层是 Portal 到 body 的，不在 container 里。
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    rerender(<DynamicProbe n={0} />);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("触发元素自己卸载后不留在错误位置，也不在下一次自己弹回来", () => {
    const { container, rerender } = render(<DynamicProbe n={1} />);
    fireEvent.click(container.querySelector("button")!);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // 最后一条跑完：锚点与浮层一起消失（游离元素的 rect 全是 0，会算到视口左上角）。
    rerender(<DynamicProbe n={0} />);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // 新任务到来：按钮回来了，但列表得等用户再点一次才展开。
    rerender(<DynamicProbe n={1} />);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
