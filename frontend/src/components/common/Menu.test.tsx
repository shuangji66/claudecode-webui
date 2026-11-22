import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { anchoredPosition, attachedPosition, Menu, menuHeight, panelMaxHeight, useDismiss, type MenuItem } from "./Menu";

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

/** 造一个只有位置信息的假触发器。 */
function anchor(top: number, bottom: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top, bottom, left: 100, right: 130, width: 30, height: bottom - top, x: 100, y: top, toJSON: () => ({}) }),
  } as unknown as HTMLElement;
}

describe("anchoredPosition", () => {
  it("下方空间不够时贴着触发器向上展开（用 bottom 锚定，不飘到视口顶端）", () => {
    // jsdom 默认 innerHeight=768：触发器贴着底部，下面只剩 ~40px。
    const pos = anchoredPosition(anchor(700, 720), 320, 900);
    expect(pos.bottom).toBe(768 - 700 + 4);
    expect(pos.top).toBeUndefined();
    // 高度被视口可用空间与上限同时约束
    expect(pos.maxHeight).toBe(panelMaxHeight());
  });

  it("下方放得下就向下展开，并把高度限制在可用空间内", () => {
    const pos = anchoredPosition(anchor(10, 30), 320, 900);
    expect(pos.top).toBe(34);
    expect(pos.bottom).toBeUndefined();
    expect(pos.maxHeight).toBe(panelMaxHeight());
  });

  it("窄屏时宽度收到视口内，left 也不越界", () => {
    const pos = anchoredPosition(anchor(10, 30), 2000, 120, "end");
    expect(pos.width).toBe(window.innerWidth - 16);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });
});

describe("menuHeight", () => {
  // 侧栏「分组 / 排序 / 筛选」菜单的实际样子：8 项 + 3 个分组标题。
  // 漏算分组标题时估算只有 248，手机竖屏（456px 高）里会被裁出一条滚动条。
  it("把分组标题算进高度：8 项 3 组超过 300", () => {
    const items = [
      { group: "分组方式" },
      { group: undefined },
      { group: undefined },
      { group: "排序方式" },
      { group: undefined },
      { group: "筛选会话" },
      { group: undefined },
      { group: undefined },
    ];
    expect(menuHeight(items)).toBe(8 * 30 + 3 * 23 + 8);
  });

  it("同一分组只在第一项前多一行，空菜单只有内边距", () => {
    expect(menuHeight([])).toBe(8);
    expect(menuHeight([{ group: "a" }, { group: "a" }])).toBe(30 * 2 + 23 + 8);
  });

  it("带 meta 的两行项按 44px 估算", () => {
    // 子代理列表：标题一行 + 类型一行。按 30 算会让下沿被裁、或凭空多一条滚动条。
    expect(menuHeight([{ group: undefined }, { group: undefined, meta: "Explore" }])).toBe(30 + 44 + 8);
  });
});

describe("Menu 的高度上限（可展开的详情）", () => {
  /** 渲染一个打开的菜单，返回面板上的 `maxHeight`（jsdom 里 innerHeight=768）。 */
  function maxHeightWith(items: MenuItem[]): string {
    const anchorEl = document.createElement("button");
    document.body.appendChild(anchorEl);
    const { unmount } = render(<Menu open anchor={anchorEl} items={items} onClose={() => {}} />);
    const panel = document.querySelector('[role="menu"]') as HTMLElement;
    const value = panel.style.maxHeight;
    unmount();
    anchorEl.remove();
    return value;
  }

  it("普通菜单按折叠态的估算封顶，不会无故长高", () => {
    // 一行 30px + 内边距 8px 的估算小于 MIN_PANEL_HEIGHT(120)，由下限兜住。
    expect(maxHeightWith([{ id: "a", label: "x", onSelect: () => {} }])).toBe("120px");
  });

  it("有可展开的详情时放宽到通用上限，详情不被裁成一条缝", () => {
    // 详情块的真实高度只有渲染后才知道（命令原文能有两三行）。仍按折叠态的估算封顶时，
    // 点开一行只能在 120px 的窗口里滚动——「就地展开」等于没展开。面板没有固定高度
    // （高度由内容决定，这只是一个上限），所以收起时不会多出空白。
    expect(maxHeightWith([{ id: "a", label: "x", onSelect: () => {}, detail: <p>详情</p> }])).toBe("560px");
  });
});
