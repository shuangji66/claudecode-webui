import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolCardHost } from "./ToolCardHost";
import type { ToolItem } from "../../lib/model";

const copyText = vi.fn();

vi.mock("../../lib/clipboard", () => ({
  copyText: (text: string) => copyText(text),
}));

beforeEach(() => {
  copyText.mockReset();
  copyText.mockResolvedValue(true);
});

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
    expect(screen.getByText("运行命令")).toBeInTheDocument();
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
    expect(screen.getByText("写入文件")).toBeInTheDocument();
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
    expect(screen.getByText("运行命令")).toBeInTheDocument();
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

describe("工具卡片的复制入口", () => {
  it("命令块上有一颗复制按钮，复制的是整条命令（含换行）", async () => {
    render(<ToolCardHost item={tool({ input: { command: "cd /tmp\necho hi" } })} />);
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("cd /tmp\necho hi"));
  });

  it("回执是图标换勾：按钮的可访问名跟着变成「已复制」", async () => {
    render(<ToolCardHost item={tool()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  // 命令是横向可滚的：按钮浮在上面的话会一直压着文字，只有拖到最右侧才看得见那几个
  // 字（截图复现过）。`pr-*` 也救不了——滚动时内边距跟着文字一起走。
  it("复制按钮不在可滚动的命令块上面", () => {
    const { container } = render(<ToolCardHost item={tool({ input: { command: `ls ${"x".repeat(200)}` } })} />);
    const pre = container.querySelector("pre") as HTMLElement;
    const button = screen.getByRole("button", { name: "复制命令" });
    expect(pre.contains(button)).toBe(false);
    // 兄弟节点：滚动的是命令，按钮在它右边（深色底由外层那一行给）。
    expect(pre.nextElementSibling).toBe(button);
    expect(pre.className).toContain("min-w-0");
    expect(pre.className).toContain("overflow-x-auto");
  });

  // overlay 滚动条的滑块是画在内容**上面**的：默认样式下那条横条会横穿这一行命令
  // （截图复现过）。所以命令块自己画滚动条 + 在文字下面留一条带子给滑块。
  it("命令块的横向滚动条不会盖住文字", () => {
    render(<ToolCardHost item={tool({ input: { command: `ls ${"x".repeat(200)}` } })} />);
    const pre = screen.getByRole("button", { name: "复制命令" }).parentElement!.querySelector("pre") as HTMLElement;
    expect(pre.className).toContain("code-scroll");
    // 10px 的带子：8–10px 的 overlay 滑块只会落在这里，不压字。
    expect(pre.className).toContain("pb-2.5");
  });

  // 输出默认是收起的：复制入口得在折叠块标题行上，不用先展开再选中。
  it("输出不用展开就能复制", async () => {
    render(<ToolCardHost item={tool({ result: "line1\nline2" })} />);
    expect(screen.queryByText("line1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("line1\nline2"));
  });
});

describe("工具名的中文标题", () => {
  it("没有专属卡片的工具同样有中文名（Read / Grep）", () => {
    render(<ToolCardHost dense item={tool({ name: "Read", input: { file_path: "/w/a.md" } })} />);
    expect(screen.getByText("读取文件")).toBeInTheDocument();
    render(<ToolCardHost dense item={tool({ name: "Grep", input: { pattern: "todo" } })} />);
    expect(screen.getByText("搜索内容")).toBeInTheDocument();
  });

  it("未收录的工具回落原名，不能变成空标题", () => {
    render(<ToolCardHost dense item={tool({ name: "mcp__fs__stat", input: { path: "/w" } })} />);
    expect(screen.getByText("mcp__fs__stat")).toBeInTheDocument();
  });
});
