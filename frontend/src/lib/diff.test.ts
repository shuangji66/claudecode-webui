import { describe, expect, it } from "vitest";
import { buildDiff, editSummary } from "./diff";

describe("buildDiff", () => {
  it("优先使用 structuredPatch，并统计增删行", () => {
    const structured = {
      structuredPatch: [
        {
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 3,
          lines: [" ctx", "-old", "+new1", "+new2"],
        },
      ],
    };
    const d = buildDiff({ file_path: "/a.go" }, structured);
    expect(d).not.toBeNull();
    expect(d!.added).toBe(2);
    expect(d!.removed).toBe(1);
    expect(d!.lines[0]).toEqual({ type: "hunk", text: "@@ -10,2 +10,3 @@" });
    expect(d!.lines[1]).toEqual({ type: "ctx", text: "ctx" });
    expect(d!.lines[2]).toEqual({ type: "del", text: "old" });
  });

  it("没有结构化补丁时退回 old_string / new_string", () => {
    const d = buildDiff({ file_path: "/a.ts", old_string: "a\nb", new_string: "a\nc" }, undefined);
    expect(d!.removed).toBe(2);
    expect(d!.added).toBe(2);
    expect(d!.lines.filter((l) => l.type === "del")).toHaveLength(2);
  });

  it("两者都没有时返回 null（由调用方降级）", () => {
    expect(buildDiff({ file_path: "/a" }, undefined)).toBeNull();
  });

  it("structuredPatch 为空数组时也应降级", () => {
    expect(buildDiff({ old_string: "x", new_string: "y" }, { structuredPatch: [] })!.added).toBe(1);
  });
});

describe("editSummary", () => {
  it("包含路径与增删统计", () => {
    const d = buildDiff({ file_path: "/a.go", old_string: "x", new_string: "y" }, undefined);
    expect(editSummary({ file_path: "/a.go" }, d)).toBe("/a.go  +1 −1");
  });

  it("无 diff 时只显示路径", () => {
    expect(editSummary({ file_path: "/a.go" }, null)).toBe("/a.go");
  });
});
