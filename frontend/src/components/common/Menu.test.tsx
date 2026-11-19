import { describe, expect, it } from "vitest";
import { attachedPosition } from "./Menu";

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
