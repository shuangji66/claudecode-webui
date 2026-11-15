import { describe, expect, it } from "vitest";
import { attachmentLimit, classifyAttachment, formatBytes } from "./attachments";

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
