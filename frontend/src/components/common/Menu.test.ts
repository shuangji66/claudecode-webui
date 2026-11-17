import { describe, expect, it } from "vitest";
import { anchoredPosition, menuHeight, panelMaxHeight } from "./Menu";

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
});
