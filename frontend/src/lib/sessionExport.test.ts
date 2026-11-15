import { describe, expect, it } from "vitest";
import { sessionToMarkdown } from "./sessionExport";
import type { Item } from "./model";

const items: Item[] = [
  { id: "u", seq: 0, ts: 0, kind: "user", text: "你好" },
  { id: "a", seq: 1, ts: 0, kind: "assistant", text: "你好，**世界**。", streaming: false },
  { id: "t", seq: 2, ts: 0, kind: "tool", toolUseId: "x", name: "Bash", input: { command: "ls" }, result: "a\nb" },
  { id: "r", seq: 3, ts: 0, kind: "result", durationMs: 1000, costUsd: 1.23 },
];

describe("sessionToMarkdown", () => {
  it("包含用户/助手/工具，跳过费用", () => {
    const md = sessionToMarkdown({ title: "测试会话", cwd: "/tmp/proj", items, locale: "zh", now: new Date("2026-01-01T00:00:00Z") });
    expect(md).toContain("# 测试会话");
    expect(md).toContain("## 用户");
    expect(md).toContain("## Claude");
    expect(md).toContain("工具: Bash");
    expect(md).toContain('"command": "ls"');
    expect(md).not.toContain("1.23");
    expect(md).not.toContain("$");
  });

  it("英文标题与空标题回落", () => {
    const md = sessionToMarkdown({ title: "", cwd: "/x", items: [], locale: "en" });
    expect(md.startsWith("# Claude Code")).toBe(true);
    expect(md).toContain("Workspace");
  });
});
