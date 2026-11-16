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

  it("成功回合只显示耗时", () => {
    const { container } = render(
      <ResultBar item={{ id: "r2", seq: 0, ts: 0, kind: "result", durationMs: 2500 }} />,
    );
    expect(container.textContent).toContain("2.5s");
    expect(container.querySelector("pre")).toBeNull();
  });
});
