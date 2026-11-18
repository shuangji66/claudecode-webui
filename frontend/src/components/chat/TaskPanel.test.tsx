import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskPanel } from "./TaskPanel";
import type { Item, ToolItem } from "../../lib/model";

function tool(over: Partial<ToolItem>): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "TaskCreate",
    input: {},
    ...over,
  };
}

describe("TaskPanel", () => {
  it("没有任务时什么都不画", () => {
    const { container } = render(<TaskPanel items={[]} />);
    expect(container.textContent).toBe("");
  });

  it("默认收起：只报数量，点开才看到清单", () => {
    const items: Item[] = [
      tool({ id: "a", input: { subject: "写后端" }, result: "Task #1 created successfully" }),
    ];
    render(<TaskPanel items={items} />);
    expect(screen.getByText("1 待完成")).toBeTruthy();
    expect(screen.queryByText("写后端")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("写后端")).toBeTruthy();
  });

  it("标题按「已完成 · 进行中 · 待完成」报数量，进行中的优先显示 activeForm", () => {
    const items: Item[] = [
      tool({ id: "a", input: { subject: "写后端 fsapi" }, result: "Task #1 created successfully" }),
      tool({ id: "b", input: { subject: "前端 mention 接入" }, result: "Task #2 created successfully" }),
      tool({
        id: "c",
        name: "TaskUpdate",
        input: { taskId: "1", status: "in_progress", activeForm: "正在写后端 fsapi" },
        result: "Updated task #1 status",
      }),
    ];
    render(<TaskPanel items={items} />);
    expect(screen.getByText("任务")).toBeTruthy();
    expect(screen.getByText("1 进行中 · 1 待完成")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("正在写后端 fsapi")).toBeTruthy();
    expect(screen.getByText("前端 mention 接入")).toBeTruthy();
  });

  it("依赖未完成的任务标「等待 #1」", () => {
    const items: Item[] = [
      tool({
        name: "TaskList",
        result: "#1 [in_progress] 写后端\n#2 [pending] 写前端 [blocked by #1]",
      }),
    ];
    render(<TaskPanel items={items} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("等待 #1")).toBeTruthy();
  });

  it("全部完成时标题只报「N 已完成」，清单里也不划线（靠灰字与对勾区分）", () => {
    const items: Item[] = [
      tool({ name: "TaskList", result: "#1 [completed] 写后端\n#2 [completed] 写前端" }),
    ];
    render(<TaskPanel items={items} />);
    expect(screen.getByText("2 已完成")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    const done = screen.getByText("写后端");
    expect(done.className).toContain("text-faint");
    expect(done.className).not.toContain("line-through");
  });
});
