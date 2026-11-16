import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FileIcon, FolderIcon, classifyFile } from "./FileIcon";

describe("classifyFile", () => {
  it("按扩展名区分语言与类别", () => {
    expect(classifyFile("main.go").kind).toBe("code");
    expect(classifyFile("main.go").color).toBe("#06B6D4");
    expect(classifyFile("app.tsx").kind).toBe("code");
    expect(classifyFile("README.md").kind).toBe("doc");
    expect(classifyFile("logo.PNG").kind).toBe("image");
    expect(classifyFile("bundle.zip").kind).toBe("archive");
    expect(classifyFile("schema.sql").kind).toBe("db");
    expect(classifyFile("run.sh").kind).toBe("shell");
    expect(classifyFile("data.json").kind).toBe("data");
    expect(classifyFile("styles.scss").kind).toBe("style");
    expect(classifyFile("page.html").kind).toBe("markup");
  });

  it("特殊文件名优先于扩展名", () => {
    expect(classifyFile("Dockerfile").kind).toBe("docker");
    expect(classifyFile(".gitignore").kind).toBe("git");
    expect(classifyFile("Makefile").kind).toBe("make");
    expect(classifyFile("go.mod").kind).toBe("code");
    expect(classifyFile("LICENSE").kind).toBe("doc");
  });

  it("认不出来的回落成通用文件", () => {
    expect(classifyFile("noext").kind).toBe("file");
    expect(classifyFile("weird.zzz").kind).toBe("file");
    expect(classifyFile(".env.local").kind).toBe("data");
  });
});

describe("图标渲染", () => {
  it("文件与文件夹都渲染成装饰性 svg", () => {
    const { container } = render(
      <div>
        <FileIcon name="a.go" />
        <FolderIcon open />
        <FolderIcon />
      </div>,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});
