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
});
