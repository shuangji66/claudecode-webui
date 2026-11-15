import { describe, expect, it } from "vitest";
import {
  asAddedDiff,
  diffStat,
  formatBytes,
  groupChanges,
  lineCountLabel,
  parseUnifiedDiff,
  previewKind,
  refsLabel,
  statusOfXY,
} from "./workspace";
import type { GitStatusEntry } from "../transport/types";

describe("statusOfXY", () => {
  it("区分索引侧与工作区侧", () => {
    expect(statusOfXY("M ")).toMatchObject({ letter: "M", tone: "modified", staged: true, unstaged: false });
    expect(statusOfXY(" M")).toMatchObject({ letter: "M", staged: false, unstaged: true });
    expect(statusOfXY("MM")).toMatchObject({ staged: true, unstaged: true });
    expect(statusOfXY("??")).toMatchObject({ letter: "U", tone: "untracked", staged: false, unstaged: true });
  });

  it("冲突优先于普通修改", () => {
    expect(statusOfXY("UU")?.conflict).toBe(true);
    expect(statusOfXY("AA")?.tone).toBe("conflict");
    expect(statusOfXY("DD")?.tone).toBe("conflict");
  });

  it("干净/忽略项返回 undefined", () => {
    expect(statusOfXY("  ")).toBeUndefined();
    expect(statusOfXY("!!")).toBeUndefined();
  });
});

describe("groupChanges", () => {
  const entries: GitStatusEntry[] = [
    { path: "both.ts", xy: "MM" },
    { path: "staged.ts", xy: "A " },
    { path: "work.ts", xy: " M" },
    { path: "new.ts", xy: "??" },
    { path: "conflict.ts", xy: "UU" },
  ];

  it("MM 同时进入暂存与更改两组，并使用本侧的 XY", () => {
    const groups = groupChanges(entries);
    expect(groups.staged.map((r) => r.entry.path)).toEqual(["both.ts", "staged.ts"]);
    expect(groups.unstaged.map((r) => r.entry.path)).toEqual(["both.ts", "new.ts", "work.ts"]);
    expect(groups.staged[0]!.xy).toBe("M ");
    expect(groups.unstaged[0]!.xy).toBe(" M");
    expect(groups.unstaged.find((r) => r.entry.path === "new.ts")!.xy).toBe("??");
  });

  it("冲突单独成组，不重复进入两侧", () => {
    const groups = groupChanges(entries);
    expect(groups.conflicts.map((r) => r.entry.path)).toEqual(["conflict.ts"]);
    expect(groups.staged.some((r) => r.entry.path === "conflict.ts")).toBe(false);
    expect(groups.unstaged.some((r) => r.entry.path === "conflict.ts")).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("解析 hunk、增删与上下文行号", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+two changed",
      "+three",
      " four",
    ].join("\n");
    const lines = parseUnifiedDiff(text);
    expect(lines.filter((l) => l.kind === "hunk")).toHaveLength(1);
    const add = lines.find((l) => l.kind === "add" && l.text === "two changed");
    expect(add).toMatchObject({ newNo: 2 });
    const del = lines.find((l) => l.kind === "del");
    expect(del).toMatchObject({ text: "two", oldNo: 2 });
    expect(diffStat(lines)).toEqual({ added: 2, removed: 1 });
  });

  it("hunk 内以 -- / ++ 开头的内容行不会被误判成文件头", () => {
    const text = [
      "@@ -1,1 +1,3 @@",
      " base",
      "+-- removed? no, added",
      "+++ still content",
    ].join("\n");
    const lines = parseUnifiedDiff(text);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["-- removed? no, added", "++ still content"]);
  });

  it("未跟踪文件的伪 diff 没有 hunk 也能识别为新增", () => {
    const lines = parseUnifiedDiff(asAddedDiff("a\nb\n"));
    expect(lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(diffStat(lines)).toEqual({ added: 2, removed: 0 });
  });
});

describe("preview/format helpers", () => {
  it("按扩展名选择预览方式", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("a/b/logo.PNG")).toBe("image");
    expect(previewKind("manual.pdf")).toBe("pdf");
    expect(previewKind("main.go")).toBe("text");
    expect(previewKind("Makefile")).toBe("text");
  });

  it("格式化字节与行数", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(lineCountLabel({ additions: 1, deletions: 0 })).toBe("+1 −0");
    expect(lineCountLabel({ additions: 0, deletions: 0, binary: true })).toBe("bin");
    expect(lineCountLabel(undefined)).toBe("");
  });

  it("refs 去掉 HEAD 前缀", () => {
    expect(refsLabel("HEAD -> main, origin/main")).toBe("main, origin/main");
  });
});
