import { describe, expect, it } from "vitest";
import { isPreviewableImage, resolveMedia } from "./markdownMedia";

const CWD = "/vol1/@appshare/ClaudeCode";

describe("resolveMedia 协议分流", () => {
  it("http(s) 归为 remote，不内联", () => {
    expect(resolveMedia("https://example.com/a.png", CWD)).toEqual({
      kind: "remote",
      url: "https://example.com/a.png",
    });
  });

  it("位图 data URI 直接内联", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveMedia(src, CWD)).toEqual({ kind: "inline", url: src });
  });

  it("SVG data URI 被拒绝：同源页面里 SVG 能带脚本", () => {
    const src = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";
    expect(resolveMedia(src, CWD).kind).toBe("reject");
  });

  it("file: / javascript: / blob: 一律拒绝", () => {
    for (const src of ["file:///etc/passwd", "javascript:alert(1)", "blob:abc"]) {
      expect(resolveMedia(src, CWD).kind).toBe("reject");
    }
  });

  it("空地址与控制字符被拒绝", () => {
    expect(resolveMedia("   ", CWD).kind).toBe("reject");
    expect(resolveMedia("probe/a\u0000.png", CWD).kind).toBe("reject");
  });
});

describe("resolveMedia 工作区路径", () => {
  it("相对路径原样归一化", () => {
    expect(resolveMedia("probe/quad.png", CWD)).toEqual({ kind: "workspace", rel: "probe/quad.png" });
  });

  it("去掉 ./ 与多余的斜杠", () => {
    expect(resolveMedia("./probe//out/../quad.png", CWD)).toEqual({
      kind: "workspace",
      rel: "probe/quad.png",
    });
  });

  it("工作区内的绝对路径换算成相对路径（后端拒绝绝对路径）", () => {
    expect(resolveMedia(`${CWD}/probe/quad.png`, CWD)).toEqual({
      kind: "workspace",
      rel: "probe/quad.png",
    });
  });

  it("工作区外的绝对路径被拒绝", () => {
    expect(resolveMedia("/etc/passwd", CWD).kind).toBe("reject");
    expect(resolveMedia("/vol1/@appshare/Other/a.png", CWD).kind).toBe("reject");
  });

  it("用 .. 逃出工作区的相对路径被拒绝", () => {
    expect(resolveMedia("../../etc/passwd", CWD).kind).toBe("reject");
    expect(resolveMedia("probe/../../secret.png", CWD).kind).toBe("reject");
  });

  it("cwd 为空时不做文件解析", () => {
    expect(resolveMedia("probe/quad.png", "").kind).toBe("reject");
  });

  it("cwd 末尾带斜杠不影响解析", () => {
    expect(resolveMedia(`${CWD}/probe/quad.png`, `${CWD}/`)).toEqual({
      kind: "workspace",
      rel: "probe/quad.png",
    });
  });
});

describe("isPreviewableImage", () => {
  it("放行位图扩展名，大小写不敏感", () => {
    for (const p of ["a.png", "dir/b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.ico"]) {
      expect(isPreviewableImage(p)).toBe(true);
    }
  });

  it("拒绝 SVG / 文本 / 无扩展名", () => {
    for (const p of ["a.svg", "a.md", "a.txt", "Makefile", "dir.png/name"]) {
      expect(isPreviewableImage(p)).toBe(false);
    }
  });
});
