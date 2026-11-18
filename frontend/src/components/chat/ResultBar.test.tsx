import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultBar } from "./ResultBar";

describe("ResultBar", () => {
  it("出错时显示 CLI 给的原因与子类型", () => {
    render(
      <ResultBar
        item={{
          id: "r1",
          seq: 0,
          ts: 0,
          kind: "result",
          isError: true,
          text: "API Error: 400 bad request",
          subtype: "error_during_execution",
        }}
      />,
    );
    expect(screen.getByText("API Error: 400 bad request")).toBeTruthy();
    expect(screen.getByText("执行中出错")).toBeTruthy();
    expect(screen.getByText("本轮出错")).toBeTruthy();
  });

  it("成功回合什么都不显示：耗时已经在回答下面那一行，不再重复一个胶囊", () => {
    const { container } = render(
      <ResultBar item={{ id: "r2", seq: 0, ts: 0, kind: "result", durationMs: 2500 }} />,
    );
    expect(container.textContent).toBe("");
  });

  it("被拒绝的工具调用仍然要说出来", () => {
    render(
      <ResultBar item={{ id: "r3", seq: 0, ts: 0, kind: "result", denials: [{ tool_name: "Bash" }] }} />,
    );
    expect(screen.getByText("1 次工具调用被拒绝")).toBeTruthy();
  });
});
