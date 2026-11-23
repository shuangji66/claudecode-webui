import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Collapsible } from "./Collapsible";

describe("Collapsible 的标题行动作", () => {
  // 动作在折叠按钮**之外**：嵌进去就是按钮套按钮（点一下既切换折叠又按到动作，
  // 键盘上也无法分别聚焦）。
  it("actions 在折叠按钮之外", () => {
    render(
      <Collapsible title="内置搜索" actions={<button type="button">启用</button>}>
        正文
      </Collapsible>,
    );
    const toggle = screen.getByRole("button", { name: /内置搜索/ });
    const action = screen.getByRole("button", { name: "启用" });
    expect(toggle.contains(action)).toBe(false);
  });

  // 右内边距只能跟着动作走：工具卡片、思考块这些没有 actions，按钮自己带 `px-3`，
  // 整行悬停高亮要铺满到右边缘。无条件给整行加 `pr-3` 会让它们右侧凭空多出 12px。
  it("没有 actions 时标题行不带右内边距", () => {
    render(<Collapsible title="参数">正文</Collapsible>);
    const row = screen.getByRole("button", { name: /参数/ }).parentElement!;
    expect(row.className).not.toContain("pr-3");
  });

  it("有 actions 时右内边距挂在动作那一格上", () => {
    render(
      <Collapsible title="内置搜索" actions={<button type="button">启用</button>}>
        正文
      </Collapsible>,
    );
    const cell = screen.getByRole("button", { name: "启用" }).parentElement!;
    expect(cell.className).toContain("pr-3");
  });

  /**
   * 流式摘要的渐变（`summaryStreaming`）。
   *
   * `mask-image` 是固定 48px 的，**短摘要也会被啃掉末尾几个字**（截图确认过：只写
   * 「短摘要」四个字，最后的「要」半透明）。而 `text-overflow` 能自己判溢出、`mask`
   * 不能——判断溢出又必须读 `scrollWidth`，那正是要根除的每帧强制同步布局。
   * 所以按字符数近似：够短就不挂 `data-streaming`，交给 `text-overflow` 兜着。
   */
  it("流式摘要长到可能溢出时才开渐隐，短的不开", () => {
    const { container, rerender } = render(
      <Collapsible title="正在思考" summary="短摘要" summaryTail summaryStreaming>
        正文
      </Collapsible>,
    );
    const short = container.querySelector(".summary-tail")!;
    expect(short.getAttribute("data-streaming")).toBeNull();

    rerender(
      <Collapsible
        title="正在思考"
        summary="这一行是流式摘要，它很长很长很长很长很长很长很长很长"
        summaryTail
        summaryStreaming
      >
        正文
      </Collapsible>,
    );
    expect(container.querySelector(".summary-tail")!.getAttribute("data-streaming")).toBe("true");
  });

  it("结束态的摘要不带渐隐（用省略号）", () => {
    const { container } = render(
      <Collapsible title="思考过程" summary="很长很长很长很长很长很长很长很长很长很长很长" summaryTail>
        正文
      </Collapsible>,
    );
    expect(container.querySelector(".summary-tail")!.getAttribute("data-streaming")).toBeNull();
  });
});
