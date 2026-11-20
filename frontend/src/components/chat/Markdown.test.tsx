import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Markdown, MarkdownMediaContext, parseBlocks, renderInline, splitFences } from "../common/Markdown";

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

describe("Markdown 长内容不撑破消息区", () => {
  // 手机上整屏能左右滑动、两边被裁掉，起因常常就是模型写的一条长路径 / 长文件名。
  // `break-words` 只在「单词」层面断，对这种没有断点的长串完全无效。
  it("正文、标题、列表项、行内代码都按任意点折行", () => {
    const long = "x".repeat(200);
    const { container } = render(
      <Markdown text={`看 ${long}.txt\n\n## ${long}\n\n- ${long}\n\n\`${long}\``} />,
    );
    for (const el of [
      container.querySelector("p"),
      container.querySelector("h2"),
      container.querySelector("li"),
      container.querySelector("code"),
    ]) {
      expect(el?.className).toContain("[overflow-wrap:anywhere]");
    }
  });

  it("代码块与表格各自是内层横向滚动，且不吃满消息区宽度", () => {
    const { container } = render(<Markdown text={"```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |"} />);
    const pre = container.querySelector("pre")!;
    expect(pre.className).toContain("overflow-x-auto");
    expect(pre.className).toContain("max-w-full");
    const tableWrap = container.querySelector("table")!.parentElement!;
    expect(tableWrap.className).toContain("overflow-x-auto");
    expect(tableWrap.className).toContain("max-w-full");
  });
});

describe("Markdown 正文图片", () => {
  const CWD = "/vol1/@appshare/ClaudeCode";
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  function withMedia(node: React.ReactNode, open: (image: { src: string; alt: string; rel?: string }) => void = () => {}) {
    return render(
      <MarkdownMediaContext.Provider value={{ cwd: CWD, open }}>{node}</MarkdownMediaContext.Provider>,
    );
  }

  it("相对路径渲染成 /api/fs/raw 的 img", () => {
    const { container } = withMedia(<Markdown text={"![四色](probe/quad.png)"} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("/api/fs/raw");
    expect(img?.getAttribute("src")).toContain(encodeURIComponent("probe/quad.png"));
    expect(img?.getAttribute("alt")).toBe("四色");
    // 不能把 ! 和链接留成残渣
    expect(container.textContent).toBe("");
  });

  it("工作区内的绝对路径换算成相对路径后请求", () => {
    const { container } = withMedia(<Markdown text={`![](${CWD}/probe/quad.png)`} />);
    const src = container.querySelector("img")?.getAttribute("src") ?? "";
    const path = new URL(src, "http://x").searchParams.get("path");
    // 后端拒绝绝对路径，必须是相对 cwd 的写法
    expect(path).toBe("probe/quad.png");
  });

  it("位图 data URI 直接内联", () => {
    const { container } = withMedia(<Markdown text={`![红](${PNG})`} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG);
  });

  it("SVG data URI 不内联，退回字面文本", () => {
    const src = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    const { container } = withMedia(<Markdown text={`![图](${src})`} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(`![图](${src})`);
  });

  it("远程图片不自动加载，只给链接", () => {
    const { container } = withMedia(<Markdown text={"![x](https://example.com/a.png)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a.png");
  });

  it("工作区外的绝对路径退回字面文本", () => {
    const { container } = withMedia(<Markdown text={"![x](/etc/passwd)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("![x](/etc/passwd)");
  });

  it("没有 provider 时保持旧行为（不渲染 img）", () => {
    const { container } = render(<Markdown text={"![x](probe/quad.png)"} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("图片加载失败时退回字面语法，不显示破图", () => {
    const { container } = withMedia(<Markdown text={"![x](probe/missing.png)"} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("![x](probe/missing.png)");
  });

  it("工作区图片把相对路径一起交给 open（右侧栏要靠它打开）", () => {
    const seen: { src: string; rel?: string }[] = [];
    const { container } = withMedia(<Markdown text={"![四色](probe/quad.png)"} />, (image) => seen.push(image));
    fireEvent.click(container.querySelector("img")!);
    expect(seen[0]?.rel).toBe("probe/quad.png");
  });

  it("内联 data URI 不带 rel：没有可打开的文件", () => {
    const seen: { src: string; rel?: string }[] = [];
    const { container } = withMedia(<Markdown text={`![红](${PNG})`} />, (image) => seen.push(image));
    fireEvent.click(container.querySelector("img")!);
    expect(seen[0]?.rel).toBeUndefined();
  });

  it("点击图片调用 open 传可用的 src", () => {
    const seen: string[] = [];
    const { container } = withMedia(<Markdown text={"![四色](probe/quad.png)"} />, (image) => seen.push(image.src));
    fireEvent.click(container.querySelector("img")!);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/api/fs/raw");
  });
});
