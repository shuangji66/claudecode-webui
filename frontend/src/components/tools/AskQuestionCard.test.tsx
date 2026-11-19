import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCardHost } from "./ToolCardHost";
import type { ToolItem } from "../../lib/model";

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "用哪个数据库？",
          header: "数据库",
          options: [
            { label: "Postgres (Recommended)", description: "事务与扩展都成熟" },
            { label: "SQLite", description: "零运维" },
          ],
        },
      ],
    },
    ...over,
  };
}

describe("提问的历史卡片", () => {
  it("没有结果时显示「等待回答」", () => {
    render(<ToolCardHost item={tool()} />);
    expect(screen.getByText("等待回答")).toBeInTheDocument();
    expect(screen.getByText("用哪个数据库？")).toBeInTheDocument();
  });

  it("从结果的 answers 里标出用户选的选项", () => {
    render(<ToolCardHost item={tool({ result: '{"answers":{"用哪个数据库？":"SQLite"}}' })} />);
    expect(screen.getByText("已回答")).toBeInTheDocument();
    const sqlite = screen.getByText("SQLite");
    const postgres = screen.getByText("Postgres");
    // 选中的那一项用强调色，未选中的保持次要色
    expect(sqlite.className).toContain("text-ink");
    expect(postgres.className).toContain("text-muted");
  });

  it("逐题拒绝显示「已跳过这题」，不显示成自定义回答", () => {
    render(
      <ToolCardHost
        item={tool({ result: '{"answers":{"用哪个数据库？":"（用户跳过此题，按你的最佳判断继续）"}}' })}
      />,
    );
    expect(screen.getByText("已跳过这题")).toBeInTheDocument();
    expect(screen.queryByText(/自定义回答/)).toBeNull();
  });

  it("自定义回答单独一行", () => {
    render(<ToolCardHost item={tool({ result: '{"answers":{"用哪个数据库？":"其实用 MySQL"}}' })} />);
    expect(screen.getByText(/自定义回答：其实用 MySQL/)).toBeInTheDocument();
  });

  it("结果形状认不出时保留原文（折叠块），不吞掉", () => {
    render(<ToolCardHost item={tool({ result: "User has answered your questions" })} />);
    expect(screen.getByText("原始结果")).toBeInTheDocument();
    expect(screen.getByText("User has answered your questions")).toBeInTheDocument();
  });

  it("载荷结构不合法时回落兜底卡片", () => {
    render(<ToolCardHost item={tool({ input: { nope: true } })} />);
    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument();
    expect(screen.getByText("参数")).toBeInTheDocument();
  });
});
