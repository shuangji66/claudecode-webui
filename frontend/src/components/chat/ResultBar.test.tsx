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

  // 模型拒答时 CLI 给的是 subtype=success + is_error=true，不能把 "success"
  // 当失败原因摆出来（原因正文在下面那一段里）。
  it("拒答不显示 success 这个「子类型」", () => {
    const { container } = render(
      <ResultBar
        item={{
          id: "r4",
          seq: 0,
          ts: 0,
          kind: "result",
          isError: true,
          subtype: "success",
          text: "The user doesn't want to proceed with this tool use.",
        }}
      />,
    );
    expect(screen.getByText("本轮出错")).toBeTruthy();
    expect(container.textContent).not.toContain("success");
    expect(screen.getByText(/doesn't want to proceed/)).toBeTruthy();
  });

  it("未收录的子类型原样显示（结构化输出重试用尽有中文）", () => {
    const { container, rerender } = render(
      <ResultBar item={{ id: "r5", seq: 0, ts: 0, kind: "result", isError: true, subtype: "weird_subtype" }} />,
    );
    expect(screen.getByText("weird_subtype")).toBeTruthy();
    rerender(
      <ResultBar
        item={{ id: "r6", seq: 0, ts: 0, kind: "result", isError: true, subtype: "error_max_structured_output_retries" }}
      />,
    );
    expect(screen.getByText("结构化输出重试次数用尽")).toBeTruthy();
    expect(container.textContent).not.toContain("error_max_structured_output_retries");
  });

  it("被拒绝的工具调用仍然要说出来", () => {
    render(
      <ResultBar item={{ id: "r3", seq: 0, ts: 0, kind: "result", denials: [{ tool_name: "Bash" }] }} />,
    );
    expect(screen.getByText("1 次工具调用被拒绝")).toBeTruthy();
  });
});
