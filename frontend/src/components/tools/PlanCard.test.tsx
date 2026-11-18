import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlanCard } from "./PlanCard";
import type { ToolItem } from "../../lib/model";

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "ExitPlanMode",
    input: {
      plan: "# 实施计划\n\n1. 先改 `lib/tasks.ts`\n2. 再补测试\n",
    },
    ...over,
  };
}

describe("PlanCard", () => {
  it("把计划按 Markdown 渲染，而不是摊开 JSON", () => {
    render(<PlanCard item={tool()} />);
    expect(screen.getByText("实施计划")).toBeTruthy();
    // 正文里有行内代码，Markdown 会把它拆成独立元素，所以按整段文本断言。
    expect(document.body.textContent).toContain("lib/tasks.ts");
    expect(document.body.textContent).toContain("再补测试");
    expect(document.body.textContent).not.toContain('"plan":');
  });

  it("没有 tool_result 时是「等待批准」", () => {
    render(<PlanCard item={tool()} />);
    expect(screen.getByText("等待批准")).toBeTruthy();
  });

  it("通过后显示「已通过」", () => {
    render(<PlanCard item={tool({ result: "User has approved your plan." })} />);
    expect(screen.getByText("已通过")).toBeTruthy();
  });

  it("驳回时显示「未通过」与用户给的原因", () => {
    render(
      <PlanCard
        item={tool({ isError: true, result: "用户要求先补一个回归测试再动手" })}
      />,
    );
    expect(screen.getByText("未通过")).toBeTruthy();
    expect(screen.getByText("用户要求先补一个回归测试再动手")).toBeTruthy();
  });

  it("老版本没有 plan 字段时给一句人话，不显示空白卡片", () => {
    render(<PlanCard item={tool({ input: {} })} />);
    expect(screen.getByText("这次没有提交计划正文。")).toBeTruthy();
  });
});
