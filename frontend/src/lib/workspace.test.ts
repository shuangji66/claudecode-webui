import { describe, expect, it } from "vitest";
import {
  asAddedDiff,
  decodeGitPath,
  diffStat,
  formatBytes,
  groupChanges,
  lineCountParts,
  parseDiffFiles,
  parseUnifiedDiff,
  pickRepo,
  previewKind,
  repoLabels,
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

describe("parseDiffFiles", () => {
  const text = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+two changed",
    "diff --git a/README.md b/README.md",
    "new file mode 100644",
    "index 000..333",
    "--- /dev/null",
    "+++ b/README.md",
    "@@ -0,0 +1,2 @@",
    "+# 标题",
    "+正文",
  ].join("\n");

  it("按文件切段并各自统计增删行数", () => {
    const files = parseDiffFiles(text);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "README.md"]);
    expect(files[0]).toMatchObject({ added: 1, removed: 1 });
    expect(files[1]).toMatchObject({ added: 2, removed: 0, tag: "added" });
    // 后一个文件的行不能被算进前一个。
    expect(files[0]!.lines.some((l) => l.text === "# 标题")).toBe(false);
  });

  it("改名与删除的文件靠 ±-- 头补出路径", () => {
    const renamed = parseDiffFiles([
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n"));
    expect(renamed[0]).toMatchObject({ path: "new.ts", oldPath: "old.ts", tag: "renamed" });
    // 删除的文件没有 `+++`：用旧侧名字，否则标题是空的。
    expect(renamed[1]).toMatchObject({ path: "gone.txt", tag: "deleted" });
    expect(renamed[1]!.oldPath).toBeUndefined();
  });

  it("路径含空格时按「两侧同名」那一刀切开", () => {
    const files = parseDiffFiles("diff --git a/my dir/a b.txt b/my dir/a b.txt\n--- a/my dir/a b.txt\n+++ b/my dir/a b.txt\n@@ -1 +1 @@\n-x\n+y");
    expect(files[0]!.path).toBe("my dir/a b.txt");
    expect(files[0]!.oldPath).toBeUndefined();
  });

  it("没有 diff --git 头（未跟踪文件的伪 diff）整篇算一个文件", () => {
    const files = parseDiffFiles(asAddedDiff("a\nb\n"));
    expect(files).toHaveLength(1);
    expect(files[0]!.added).toBe(2);
    expect(files[0]!.path).toBe("");
  });

  it("真实 git 输出：空格路径 + `+++` 行尾 TAB 都不会污染文件名", () => {
    // 取自实测 `git show` 的输出（core.quotePath=false）：含空格的路径以 TAB 结尾。
    const files = parseDiffFiles([
      "diff --git a/有 空格.txt b/有 空格.txt",
      "new file mode 100644",
      "index 0000000..587be6b",
      "--- /dev/null",
      "+++ b/有 空格.txt\t",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "有 空格.txt", added: 1, removed: 0, tag: "added" });
  });

  it("还原 git 的 C 引用路径", () => {
    expect(decodeGitPath('"\\346\\226\\207.md"')).toBe("文.md");
    expect(decodeGitPath("普通.md")).toBe("普通.md");
    // 空格在 git 的输出里是以 TAB 结尾的，不能把它当路径的一部分。
    expect(decodeGitPath("a b.txt\t")).toBe("a b.txt\t");
  });
});

describe("preview/format helpers", () => {
  it("按扩展名选择预览方式", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("docs/index.html")).toBe("html");
    expect(previewKind("a.HTM")).toBe("html");
    expect(previewKind("a/b/logo.PNG")).toBe("image");
    expect(previewKind("manual.pdf")).toBe("pdf");
    expect(previewKind("main.go")).toBe("text");
    expect(previewKind("Makefile")).toBe("text");
    // 无后缀/未知后缀一律先按文本试（后端再判二进制）。
    expect(previewKind("LICENSE")).toBe("text");
    expect(previewKind("data.unknownext")).toBe("text");
    // Office OOXML 就地解析；老格式（.doc/.xls/.ppt）不认，仍走二进制占位。
    expect(previewKind("方案.docx")).toBe("docx");
    expect(previewKind("报表.XLSM")).toBe("xlsx");
    expect(previewKind("deck.pptm")).toBe("pptx");
    expect(previewKind("legacy.doc")).toBe("text");
    expect(previewKind("legacy.xls")).toBe("text");
  });

  it("格式化字节与行数", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    // 只增不减：只给一段绿色 `+N`，不出 `−0`。
    expect(lineCountParts({ additions: 1, deletions: 0 })).toEqual([{ text: "+1", tone: "text-ok" }]);
    // 只删不加：只给一段红色 `−N`。
    expect(lineCountParts({ additions: 0, deletions: 3 })).toEqual([{ text: "−3", tone: "text-danger" }]);
    // 有增有删：两段各自着色，不能合并成一个灰色数字。
    expect(lineCountParts({ additions: 9, deletions: 3 })).toEqual([
      { text: "+9", tone: "text-ok" },
      { text: "−3", tone: "text-danger" },
    ]);
    // 两侧都是 0（有记录但无统计）与无统计都为空。
    expect(lineCountParts({ additions: 0, deletions: 0 })).toEqual([]);
    expect(lineCountParts({ additions: 0, deletions: 0, binary: true })).toEqual([{ text: "bin", tone: "text-faint" }]);
    expect(lineCountParts(undefined)).toEqual([]);
  });

  it("refs 去掉 HEAD 前缀", () => {
    expect(refsLabel("HEAD -> main, origin/main")).toBe("main, origin/main");
  });
});

describe("pickRepo", () => {
  const repos = [
    { path: "alpha", root: "/w/alpha" },
    { path: "beta", root: "/w/beta" },
  ];

  it("保持当前选中，只要它还在列表里", () => {
    expect(pickRepo(repos, "/w/beta")).toBe("/w/beta");
  });

  it("当前选中已消失时退回工作区根仓库，再否则第一个", () => {
    expect(pickRepo([...repos, { path: "", root: "/w" }], "/w/gone")).toBe("/w");
    expect(pickRepo(repos, "/w/gone")).toBe("/w/alpha");
  });

  it("一个仓库都没有时返回空串", () => {
    expect(pickRepo([], "/w")).toBe("");
  });

  it("会话开在某个仓库的子目录里时选中那个仓库（取最内层）", () => {
    const nested = [
      ...repos,
      { path: "alpha/vendor/dep", root: "/w/alpha/vendor/dep" },
    ];
    expect(pickRepo(nested, "", "/w/alpha/src/app")).toBe("/w/alpha");
    expect(pickRepo(nested, "", "/w/alpha/vendor/dep/src")).toBe("/w/alpha/vendor/dep");
    expect(pickRepo(nested, "", "/w")).toBe("/w/alpha");
    // 后端给的 cwd_repo 优先，且不依赖 cwd 的字符串包含关系。
    expect(pickRepo(nested, "", "", "/w/beta")).toBe("/w/beta");
  });

  it("cwd 的仓库不在列表里时不乱选别的仓库", () => {
    // 工作区只授权了仓库下面的一层：仓库根过不了围栏，列表里只有嵌套仓库。
    const inside = [{ path: "vendor/dep", root: "/w/vendor/dep" }];
    expect(pickRepo(inside, "", "/w", "/w")).toBe("");
  });
});

describe("repoLabels", () => {
  it("名字唯一时只显示名字", () => {
    const labels = repoLabels([
      { path: "", root: "/w", name: "work" },
      { path: "alpha", root: "/w/alpha", name: "alpha" },
    ]);
    expect(labels.get("/w")).toBe("work");
    expect(labels.get("/w/alpha")).toBe("alpha");
  });

  it("重名仓库改显示相对路径", () => {
    const labels = repoLabels([
      { path: "a/service", root: "/w/a/service", name: "service" },
      { path: "b/service", root: "/w/b/service", name: "service" },
      { path: "other", root: "/w/other", name: "other" },
    ]);
    expect(labels.get("/w/a/service")).toBe("a/service");
    expect(labels.get("/w/b/service")).toBe("b/service");
    expect(labels.get("/w/other")).toBe("other");
  });

  it("缺 name 时退回相对路径末段", () => {
    const labels = repoLabels([{ path: "group/gamma", root: "/w/group/gamma" }]);
    expect(labels.get("/w/group/gamma")).toBe("gamma");
  });
});
