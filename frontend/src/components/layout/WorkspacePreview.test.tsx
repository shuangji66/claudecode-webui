import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspacePreview } from "./WorkspacePreview";

const anchor = document.createElement("button");

describe("WorkspacePreview", () => {
  it("显示工作区名、路径、对话数与最近使用", () => {
    const lastUsed = new Date(Date.now() - 5 * 60_000).toISOString();
    render(
      <WorkspacePreview anchor={anchor} name="demo" path="/w/demo" exists count={3} lastUsed={lastUsed} />,
    );
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("demo");
    expect(tip).toHaveTextContent("/w/demo");
    expect(tip).toHaveTextContent("3 个对话");
    expect(tip).toHaveTextContent("最近使用 5 分钟前");
    expect(tip).not.toHaveTextContent("目录不可用");
  });

  it("没有对话 / 目录不存在时说清楚", () => {
    render(<WorkspacePreview anchor={anchor} name="gone" path="/w/gone" exists={false} count={0} />);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("暂无对话");
    expect(tip).toHaveTextContent("目录不可用");
  });
});
