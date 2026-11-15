import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown, renderInline, splitFences } from "../common/Markdown";

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
