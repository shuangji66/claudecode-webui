import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolCardHost } from "./ToolCardHost";
import type { ToolItem } from "../../lib/model";

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Bash",
    input: { command: "echo hi" },
    ...over,
  };
}

describe("ToolCardHost", () => {
  it("按工具名分派：Bash 卡片显示命令", () => {
    render(<ToolCardHost item={tool()} />);
    expect(screen.getByText(/echo hi/)).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("Bash 有结果时显示输出行数摘要", () => {
    render(<ToolCardHost item={tool({ result: "line1\nline2" })} />);
    expect(screen.getByText("2 行")).toBeInTheDocument();
  });

  it("Edit 渲染 diff", () => {
    render(
      <ToolCardHost
        item={tool({
          name: "Edit",
          input: { file_path: "/a.go", old_string: "old", new_string: "new" },
        })}
      />,
    );
    expect(screen.getByText(/\/a\.go/)).toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  // 工具集会随 CLI 版本漂移，未知工具必须有兜底卡片，否则界面出现空白。
  it("未知工具走兜底卡片并显示工具名", () => {
    render(<ToolCardHost item={tool({ name: "SomeFutureTool", input: { a: 1 } })} />);
    expect(screen.getByText("SomeFutureTool")).toBeInTheDocument();
    expect(screen.getByText("参数")).toBeInTheDocument();
  });

  it("运行中的工具标记为运行中", () => {
    render(<ToolCardHost item={tool({ name: "Whatever" })} />);
    expect(screen.getByText("运行中…")).toBeInTheDocument();
  });
});

describe("Write 与工具结果图片", () => {
  it("Write 显示写入内容，而不是「File created successfully」", () => {
    render(
      <ToolCardHost
        item={tool({
          name: "Write",
          input: { file_path: "/w/新建.md", content: "第一行\n第二行\n" },
          result: "File created successfully at /w/新建.md",
        })}
      />,
    );
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText(/新建\.md/)).toBeInTheDocument();
    expect(screen.getByText("第一行")).toBeInTheDocument();
    expect(screen.getByText("第二行")).toBeInTheDocument();
  });

  it("已注册的卡片也会画 tool_result 图片", () => {
    render(
      <ToolCardHost
        item={tool({
          name: "Bash",
          input: { command: "screenshot" },
          result: "[图片 image/png，约 1 KB]",
          images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
        })}
      />,
    );
    const img = screen.getByAltText("工具结果图片") as HTMLImageElement;
    expect(img.src).toContain("data:image/png;base64,");
  });

  it("缩略图可点开大图，标题用 Read 的文件路径", () => {
    render(
      <ToolCardHost
        item={tool({
          name: "Read",
          input: { file_path: "/tmp/shot.png" },
          result: "[图片 image/png，约 1 KB]",
          images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
        })}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /预览图片/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("/tmp/shot.png").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /关闭|Close/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("灯箱里不给「在右侧栏打开」（工具结果没有工作区相对路径）", () => {
    render(
      <ToolCardHost
        item={tool({ images: [{ mediaType: "image/jpeg", data: "AAA" }] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /预览图片/ }));
    expect(screen.queryByRole("button", { name: /在右侧栏打开/ })).toBeNull();
  });
});

describe("ToolCardHost 紧凑模式", () => {
  it("默认只占一行：工具名 + 摘要，正文要点开", () => {
    render(<ToolCardHost dense item={tool({ result: "line1\nline2" })} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.queryByText("输出")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("输出")).toBeInTheDocument();
  });

  it("失败在行内标红，不用展开就能看见", () => {
    render(<ToolCardHost dense item={tool({ result: "boom", isError: true })} />);
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("未知工具也有摘要：折叠后不能变成一行空白", () => {
    render(<ToolCardHost dense item={tool({ name: "SomeFutureTool", input: { note: "看看这个" } })} />);
    expect(screen.getByText("SomeFutureTool")).toBeInTheDocument();
    expect(screen.getByText("看看这个")).toBeInTheDocument();
  });

  it("Edit 紧凑行摘要带文件路径，展开仍是 diff", () => {
    render(
      <ToolCardHost
        dense
        item={tool({ name: "Edit", input: { file_path: "/a.go", old_string: "old", new_string: "new" } })}
      />,
    );
    const row = screen.getByRole("button", { expanded: false });
    expect(row.textContent).toContain("/a.go");
    fireEvent.click(row);
    expect(screen.getByText("old")).toBeInTheDocument();
  });
});
