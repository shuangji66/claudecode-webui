import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProcessGroup } from "./ProcessGroup";
import type { Item } from "../../lib/model";

/**
 * 过程组只管「组级开合」：默认收起，点一下看每一步。
 *
 * 整轮什么时候收进轮首那一行是另一层（`MessageList` 的 `TurnCollapse`），
 * 这里不再测收起时机——那属于 `lib/process.turnSpans` 与 `MessageList` 的用例。
 */
const items: Item[] = [
  { id: "th1", seq: 0, ts: 0, kind: "thinking", text: "思考一下" },
  {
    id: "t1",
    seq: 1,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Bash",
    input: { command: "ls" },
    result: "a",
  },
];

describe("ProcessGroup", () => {
  it("默认收起：只露一行人话摘要", () => {
    render(
      <ProcessGroup items={items}>
        <p>一步</p>
      </ProcessGroup>,
    );
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("一步")).toBeNull();
  });

  it("点开后显示每一步", () => {
    render(
      <ProcessGroup items={items}>
        <p>一步</p>
      </ProcessGroup>,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("一步")).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("组头是「已做过什么」的人话摘要，不是工具名", () => {
    render(
      <ProcessGroup items={items}>
        <p>一步</p>
      </ProcessGroup>,
    );
    expect(screen.getByText("执行了命令")).toBeInTheDocument();
    expect(screen.queryByText("运行命令")).toBeNull();
  });
});
