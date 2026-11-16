import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown, parseBlocks, renderInline, splitFences } from "../common/Markdown";

describe("splitFences", () => {
  it("分隔代码块与正文", () => {
    const segs = splitFences("前\n```go\nfmt.Println()\n```\n后");
    expect(segs.map((s) => s.type)).toEqual(["text", "code", "text"]);
    expect(segs[1].lang).toBe("go");
    expect(segs[1].content).toContain("fmt.Println()");
  });

  it("没有代码块时整体当正文", () => {
    expect(splitFences("纯文本")).toEqual([{ type: "text", content: "纯文本" }]);
  });
});

describe("renderInline", () => {
  it("渲染行内代码与加粗", () => {
    render(<div>{renderInline("用 `go test` 跑 **全部** 用例")}</div>);
    expect(screen.getByText("go test").tagName).toBe("CODE");
    expect(screen.getByText("全部").tagName).toBe("STRONG");
  });
});

describe("Markdown", () => {
  it("代码块渲染为 pre/code", () => {
    const { container } = render(<Markdown text={"```js\nconst a = 1;\n```"} />);
    const code = container.querySelector("pre code");
    expect(code?.textContent).toBe("const a = 1;");
  });

  it("多段正文拆成多个 p", () => {
    const { container } = render(<Markdown text={"第一段\n\n第二段"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });
});

describe("Markdown 块级结构", () => {
  it("标题、列表、表格、链接都按结构渲染", () => {
    const { container } = render(
      <Markdown
        text={"## 小标题\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n见 [文档](https://example.com)"}
      />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("小标题");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelector("td")?.textContent).toBe("1");
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("rel")).toContain("noreferrer");
  });

  it("拒绝 javascript: 链接", () => {
    const { container } = render(<Markdown text={"[x](javascript:alert(1))"} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("斜体与删除线", () => {
    const { container } = render(<Markdown text={"这是 *强调* 和 ~~删掉~~ 的内容"} />);
    expect(container.querySelector("em")?.textContent).toBe("强调");
    expect(container.querySelector("del")?.textContent).toBe("删掉");
  });

  it("文件名里的下划线不被当成斜体", () => {
    const { container } = render(<Markdown text={"看 my_file_name.txt 这个文件"} />);
    expect(container.querySelector("em")).toBeNull();
  });

  it("parseBlocks 识别分割线与引用", () => {
    const blocks = parseBlocks("前\n\n---\n\n> 引用");
    expect(blocks.map((b) => b.type)).toEqual(["para", "hr", "quote"]);
  });
});
