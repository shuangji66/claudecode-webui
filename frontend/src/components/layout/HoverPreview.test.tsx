import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HoverPreview } from "./HoverPreview";

function rect(over: Partial<DOMRect>): DOMRect {
  return {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...over,
  } as DOMRect;
}

describe("HoverPreview", () => {
  // 卡片从侧栏右沿展开（对话区域），而不是从行的右沿：行在侧栏里还留着 padding，
  // 从行右沿加一点距离会压在分隔线上、看着像盖住了左边栏。
  it("贴着侧栏右沿定位，不越过分隔线", () => {
    const aside = document.createElement("aside");
    aside.getBoundingClientRect = () => rect({ right: 280, left: 0, width: 280, bottom: 600, height: 600 });
    const row = document.createElement("button");
    row.getBoundingClientRect = () => rect({ left: 8, right: 272, top: 100, bottom: 128, width: 264, height: 28 });
    aside.appendChild(row);

    render(
      <HoverPreview anchor={row}>
        <p>内容</p>
      </HoverPreview>,
    );
    expect(screen.getByRole("tooltip").style.left).toBe("292px");
  });

  // 没有并排的对话区域（抽屉 / 被右侧栏挤扁）时宁可不弹，也不把卡片压在侧栏上。
  it("对话区域太窄时不渲染", () => {
    const aside = document.createElement("aside");
    aside.getBoundingClientRect = () => rect({ right: 900, left: 0, width: 900, bottom: 600, height: 600 });
    const row = document.createElement("button");
    aside.appendChild(row);

    render(
      <HoverPreview anchor={row}>
        <p>内容</p>
      </HoverPreview>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
