import { describe, expect, it } from "vitest";
import type { ToolItem } from "./model";
import { toolSummary } from "./tools";

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "i1",
    seq: 0,
    ts: 0,
    kind: "tool",
    toolUseId: "tu1",
    name: "Bash",
    input: {},
    ...over,
  };
}

describe("toolSummary", () => {
  it("Bash 取命令首行（多行脚本只显示第一行）", () => {
    expect(toolSummary(tool({ input: { command: "ls -la /tmp\necho done" } }))).toBe("ls -la /tmp");
  });

  it("文件类工具显示路径", () => {
    expect(toolSummary(tool({ name: "Read", input: { file_path: "/w/a.md" } }))).toBe("/w/a.md");
    expect(toolSummary(tool({ name: "Write", input: { file_path: "/w/b.md", content: "很长很长的正文" } }))).toBe("/w/b.md");
    expect(toolSummary(tool({ name: "Edit", input: { file_path: "/w/c.ts" } }))).toBe("/w/c.ts");
  });

  it("Glob 给「模式 · 路径」", () => {
    expect(toolSummary(tool({ name: "Glob", input: { pattern: "**/*.ts", path: "src" } }))).toBe("**/*.ts · src");
  });

  it("Agent 用任务描述，没有描述才退回 prompt 首行", () => {
    expect(toolSummary(tool({ name: "Agent", input: { description: "查依赖", prompt: "ignored" } }))).toBe("查依赖");
    expect(toolSummary(tool({ name: "Agent", input: { prompt: "第一行\n第二行" } }))).toBe("第一行");
  });

  it("未知工具回落第一个字符串参数", () => {
    expect(toolSummary(tool({ name: "SomeFutureTool", input: { count: 3, note: "看看这个" } }))).toBe("看看这个");
  });

  it("未知工具只有数组参数时显示长度", () => {
    expect(toolSummary(tool({ name: "SomeFutureTool", input: { todos: [{}, {}] } }))).toBe("[2]");
  });

  it("空入参不返回脏字符", () => {
    expect(toolSummary(tool({ name: "SomeFutureTool", input: {} }))).toBe("");
    expect(toolSummary(tool({ name: "SomeFutureTool", input: null }))).toBe("");
  });

  it("超长内容截断，不把整段文件塞进 DOM", () => {
    const long = "x".repeat(500);
    const out = toolSummary(tool({ name: "SomeFutureTool", input: { blob: long } }));
    expect(out.length).toBeLessThanOrEqual(161);
    expect(out.endsWith("…")).toBe(true);
  });
});
