import { describe, expect, it } from "vitest";
import {
  attachmentDataUrl,
  attachmentLimit,
  classifyAttachment,
  clipboardFiles,
  formatBytes,
  withPastedName,
} from "./attachments";

describe("attachments", () => {
  it("按 MIME 与扩展名识别类型", () => {
    expect(classifyAttachment("a.png", "")).toBe("image");
    expect(classifyAttachment("a", "image/jpeg")).toBe("image");
    expect(classifyAttachment("a.pdf", "")).toBe("pdf");
    expect(classifyAttachment("a.md", "")).toBe("text");
    expect(classifyAttachment("a", "text/plain")).toBe("text");
    expect(classifyAttachment("a.svg", "image/svg+xml")).toBeNull();
    expect(classifyAttachment("a.zip", "application/zip")).toBeNull();
  });

  it("单文件上限", () => {
    expect(attachmentLimit("image")).toBe(5 << 20);
    expect(attachmentLimit("pdf")).toBe(8 << 20);
    expect(attachmentLimit("text")).toBe(1 << 20);
  });

  it("格式化体积", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 << 20)).toBe("2.0 MB");
  });
});

describe("剪贴板粘贴", () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], "", { type: "image/png" });

  function clipboard(init: { items?: unknown[]; files?: File[] }): DataTransfer {
    return init as unknown as DataTransfer;
  }

  it("优先从 items 取文件（Safari / Linux 的 files 可能是空的）", () => {
    const file = png();
    const data = clipboard({ items: [{ kind: "file", getAsFile: () => file }], files: [] });
    expect(clipboardFiles(data)).toEqual([file]);
  });

  it("items 里没有文件时回落到 files", () => {
    const file = png();
    expect(clipboardFiles(clipboard({ items: [{ kind: "string" }], files: [file] }))).toEqual([file]);
  });

  it("纯文本粘贴没有文件（调用方据此不拦截默认行为）", () => {
    expect(clipboardFiles(clipboard({ items: [{ kind: "string" }], files: [] }))).toEqual([]);
    expect(clipboardFiles(null)).toEqual([]);
  });

  it("截图没有文件名时补一个可读的名字，已有名字则原样保留", () => {
    const at = new Date(2026, 10, 18, 22, 40, 27);
    expect(withPastedName(png(), at).name).toBe("clipboard-20261118-224027.png");
    expect(withPastedName(new File([new Uint8Array([1])], "", { type: "image/jpeg" }), at).name).toBe(
      "clipboard-20261118-224027.jpg",
    );
    const named = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    expect(withPastedName(named, at)).toBe(named);
  });
});

describe("附件缩略图地址", () => {
  it("按 mediaType 拼 data URL（缩略图与预览共用）", () => {
    expect(
      attachmentDataUrl({
        id: "1",
        name: "shot.png",
        mediaType: "image/png",
        data: "AAAA",
        size: 3,
        kind: "image",
      }),
    ).toBe("data:image/png;base64,AAAA");
  });
});
