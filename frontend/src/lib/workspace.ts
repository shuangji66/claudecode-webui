// 右侧栏文件树 / Git 面板的纯函数：路径、状态分组、unified diff 解析。
//
// 把 porcelain 状态与 diff 解析放在这里，而不是塞进组件：这两块规则最多、
// 最容易回归，单测覆盖的成本也最低。Git 语义参考 dsh-better-sidebar
// 的 src/client/ui/git-status.ts 与 src/client/diff/rows.ts（MIT）。

import type { GitStatusEntry } from "../transport/types";

export type GitTone = "modified" | "added" | "deleted" | "untracked" | "renamed" | "copied" | "conflict";

/** 一条变更记录在某一侧的展示状态。 */
export interface GitFileStatus {
  /** 展示字母：索引侧优先，`??` 显示 U。 */
  letter: string;
  tone: GitTone;
  /** 索引侧有改动。 */
  staged: boolean;
  /** 工作区侧有改动（未跟踪也算）。 */
  unstaged: boolean;
  conflict: boolean;
}

/** porcelain 字母 → 语义色。 */
function toneOfLetter(letter: string): GitTone | undefined {
  switch (letter) {
    case "M":
    case "T":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflict";
    default:
      return undefined;
  }
}

/** 解析 porcelain 的 XY 两字母；干净/忽略项返回 undefined。 */
export function statusOfXY(xy: string): GitFileStatus | undefined {
  if (xy === "??") return { letter: "U", tone: "untracked", staged: false, unstaged: true, conflict: false };
  if (xy.length < 2 || xy === "!!") return undefined;
  const x = xy[0]!;
  const y = xy[1]!;
  if (x === " " && y === " ") return undefined;
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " && y !== "?";
  const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
  const tone = conflict ? "conflict" : toneOfLetter(staged ? x : y) ?? "modified";
  return { letter: staged ? x : y, tone, staged, unstaged, conflict };
}

/** 一个分组里的行；xy 已被改写成该侧自己的两位，便于复用同一套渲染。 */
export interface ChangeRow {
  entry: GitStatusEntry;
  xy: string;
  status: GitFileStatus;
}

export interface ChangeGroups {
  conflicts: ChangeRow[];
  staged: ChangeRow[];
  unstaged: ChangeRow[];
}

/**
 * 把 status 列表拆成 Merge / Staged / Changes 三组。
 *
 * `MM` 这类两侧都有改动的文件会同时出现在两组，各自带本侧的 XY：
 * 把两侧行数相加会重复计数，所以在源头就按侧拆开。
 */
export function groupChanges(entries: readonly GitStatusEntry[]): ChangeGroups {
  const conflicts: ChangeRow[] = [];
  const staged: ChangeRow[] = [];
  const unstaged: ChangeRow[] = [];
  for (const entry of entries) {
    const status = statusOfXY(entry.xy);
    if (!status) continue;
    if (status.conflict) {
      conflicts.push({ entry, xy: entry.xy, status });
      continue;
    }
    if (status.staged) {
      const xy = `${entry.xy[0] ?? " "} `;
      staged.push({ entry, xy, status: statusOfXY(xy) ?? status });
    }
    if (status.unstaged) {
      const xy = entry.xy === "??" ? "??" : ` ${entry.xy[1] ?? " "}`;
      unstaged.push({ entry, xy, status: statusOfXY(xy) ?? status });
    }
  }
  const byPath = (a: ChangeRow, b: ChangeRow) => a.entry.path.localeCompare(b.entry.path);
  conflicts.sort(byPath);
  staged.sort(byPath);
  unstaged.sort(byPath);
  return { conflicts, staged, unstaged };
}

/** 所有变更里的路径集合，用于文件树着色。 */
export function changedPathSet(entries: readonly GitStatusEntry[]): Set<string> {
  return new Set(entries.map((e) => e.path));
}

export type DiffKind = "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** 解析 unified diff 文本（`git diff -U3` 的输出）。 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  return parseDiffFiles(text).flatMap((file) => file.lines);
}

/** 补丁里的一个文件段（`diff --git` 到下一段之前）。 */
export interface DiffFile {
  /** 新侧路径（删除的文件取旧侧）；这是标题与折叠块的键。 */
  path: string;
  /** git 改过名时才是旧的路径。 */
  oldPath?: string;
  /** 新增 / 删除 / 改名 / 二进制之类的徽标；普通修改为 undefined。 */
  tag?: "added" | "deleted" | "renamed" | "binary";
  /** 这一段里的行（含 hunk 头与 meta）。 */
  lines: DiffLine[];
  added: number;
  removed: number;
}

/**
 * 按文件切分 unified diff。**提交详情的差异页必须按文件分组**：
 * 一次提交动几十个文件时，平铺成一整条消息流既没处收起、也看不出改了哪些文件。
 *
 * 解析与 `parseUnifiedDiff` 是同一套行规则，区别只在「遇到 `diff --git` 就开新段」。
 * 没有 `diff --git` 头时（未跟踪文件的伪 diff、单文件片段）整篇算一个文件，
 * 路径留空由调用方给——总比丢掉不显示强。
 */
export function parseDiffFiles(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let current: DiffFile | null = null;

  const start = (): DiffFile => {
    const file: DiffFile = { path: "", lines: [], added: 0, removed: 0 };
    files.push(file);
    return file;
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      current = start();
      current.lines.push({ kind: "meta", text: raw });
      const rest = raw.slice("diff --git ".length);
      const split = splitGitHeaderPaths(rest);
      if (split) {
        current.oldPath = split.old;
        current.path = stripDiffPrefix(split.new);
      }
      continue;
    }
    if (current === null) {
      // 前面没有 `diff --git`：整篇当一个文件，别把这些行扔掉。
      if (raw === "") continue;
      current = start();
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      inHunk = true;
      current.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    // `---` / `+++` 只在 hunk 外是文件头；hunk 内它们是内容行（例如新增一行 `++ foo`
    // 在 diff 里就是 `+++ foo`），不能无条件当 meta。
    if (!inHunk && (raw.startsWith("--- ") || raw.startsWith("+++ "))) {
      current.lines.push({ kind: "meta", text: raw });
      // 新侧路径以 `+++` 为准（改名的旧名只出现在 `---`）。
      if (raw.startsWith("+++ ")) {
        const path = stripDiffPrefix(headerPath(raw.slice(4)));
        if (path && path !== "/dev/null") current.path = path;
      } else {
        const path = stripDiffPrefix(headerPath(raw.slice(4)));
        if (path && path !== "/dev/null" && !current.oldPath) current.oldPath = path;
      }
      continue;
    }
    if (!inHunk && raw.startsWith("rename from ")) {
      current.oldPath = headerPath(raw.slice("rename from ".length));
      current.tag = "renamed";
      current.lines.push({ kind: "meta", text: raw });
      continue;
    }
    if (!inHunk && raw.startsWith("rename to ")) {
      current.path = headerPath(raw.slice("rename to ".length));
      current.lines.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
      inHunk = false;
      current.tag = "binary";
      current.lines.push({ kind: "meta", text: raw });
      continue;
    }
    if (!inHunk && raw.startsWith("new file mode ")) current.tag = "added";
    if (!inHunk && raw.startsWith("deleted file mode ")) current.tag = "deleted";
    if (!inHunk && (raw.startsWith("index ") || raw.startsWith("new file mode ") || raw.startsWith("deleted file mode ") ||
        raw.startsWith("similarity index ") || raw.startsWith("old mode ") || raw.startsWith("new mode "))) {
      current.lines.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("\\ No newline")) {
      current.lines.push({ kind: "meta", text: raw });
      continue;
    }
    if (inHunk) {
      if (raw.startsWith("+")) {
        current.lines.push({ kind: "add", text: raw.slice(1), newNo });
        current.added += 1;
        newNo += 1;
      } else if (raw.startsWith("-")) {
        current.lines.push({ kind: "del", text: raw.slice(1), oldNo });
        current.removed += 1;
        oldNo += 1;
      } else if (raw.startsWith(" ")) {
        current.lines.push({ kind: "ctx", text: raw.slice(1), oldNo, newNo });
        oldNo += 1;
        newNo += 1;
      } else if (raw === "") {
        // diff 末尾的空行不是内容。
      } else {
        current.lines.push({ kind: "ctx", text: raw, oldNo, newNo });
        oldNo += 1;
        newNo += 1;
      }
      continue;
    }
    // 未跟踪文件的伪 diff 没有 hunk，整篇都是新增行。
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1) });
      current.added += 1;
    } else if (raw !== "") {
      current.lines.push({ kind: "meta", text: raw });
    }
  }
  // 删除的文件没有 `+++`：用 `---` 那一侧的名字，否则标题是空的。
  for (const file of files) {
    if (!file.path && file.oldPath) file.path = file.oldPath;
    if (file.oldPath === file.path) file.oldPath = undefined;
  }
  return files;
}

/** `--- a/x` / `+++ b/x` 后面的值：git 在路径含空格时补一个 TAB。 */
function headerPath(raw: string): string {
  return decodeGitPath(raw.endsWith("\t") ? raw.slice(0, -1) : raw);
}

/** 去掉 `a/` / `b/` 前缀（`/dev/null` 原样保留）。 */
function stripDiffPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/**
 * 拆 `diff --git a/x b/x` 的两侧路径。
 *
 * 路径里可以有空格，所以从**每一个** ` b/` 处试切，取「两侧同名」的那一刀
 * （git 在两边都写同一个路径，改名时才是两个不同的名字）。
 * 中文路径由 `-c core.quotePath=false` 保证不被 C 引用，但仍兼容引号形式。
 */
function splitGitHeaderPaths(rest: string): { old: string; new: string } | null {
  if (rest.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (quoted) return { old: decodeGitPath(quoted[1]!), new: decodeGitPath(quoted[2]!) };
    return null;
  }
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    const oldPath = rest.slice(0, at);
    const newPath = rest.slice(at + 1);
    if (oldPath.startsWith("a/") && newPath.startsWith("b/") && oldPath.slice(2) === newPath.slice(2)) {
      return { old: oldPath.slice(2), new: newPath.slice(2) };
    }
  }
  // 改名时两侧不同名：只能按最后一个 ` b/` 切（左侧一定叫 a/…）。
  const at = rest.lastIndexOf(" b/");
  if (at === -1) return null;
  const oldPath = rest.slice(0, at);
  const newPath = rest.slice(at + 1);
  if (!oldPath.startsWith("a/") || !newPath.startsWith("b/")) return null;
  return { old: oldPath.slice(2), new: newPath.slice(2) };
}

/** 还原 git 的 C 引用路径（`"\346\226\207.md"` → `文.md`）。非引用形式原样返回。 */
export function decodeGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  // 逐字符走：C 转义是字节语义，多字节字符按 UTF-8 编码后逐个 push。
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char !== "\\") {
      for (const byte of encoder.encode(char)) bytes.push(byte);
      continue;
    }
    const next = body[i + 1];
    const simple = next === undefined ? undefined : escapes[next];
    if (simple !== undefined) {
      bytes.push(simple);
      i += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    for (const byte of encoder.encode(char)) bytes.push(byte);
  }
  return decoder.decode(new Uint8Array(bytes));
}


/** 统计 diff 的增删行数（只数 add/del）。 */
export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

/** 把纯文本包装成「整文件新增」的伪 diff，供未跟踪文件预览。 */
export function asAddedDiff(text: string): string {
  const lines = text.split("\n");
  // 末尾换行不代表多一行内容；否则未跟踪文件会多显示一个空的新增行。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `+${line}`).join("\n");
}

export type FilePreviewKind = "markdown" | "html" | "image" | "pdf" | "text" | "docx" | "xlsx" | "pptx";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
/**
 * 能在浏览器里就地解析的 Office OOXML 类型（含宏变体）。
 *
 * 老格式 .doc/.xls/.ppt 是 OLE 复合文档，没有可用且可信的前端解析器，
 * 它们继续落到 "text" → 后端判 binary → 「二进制文件，请下载」。
 * 后端 `/api/fs/blob` 的白名单必须与这里逐项一致。
 */
const OFFICE_EXT: Record<string, FilePreviewKind> = {
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  pptx: "pptx",
  pptm: "pptx",
};
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "env", "log",
  "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "less", "html", "htm", "xml", "svg",
  "py", "rb", "rs", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
  "fish", "sql", "graphql", "proto", "lua", "vim", "dockerfile", "makefile", "gitignore",
]);

/** 扩展名 → 预览方式；未知扩展名按文本尝试（后端会判定二进制）。 */
export function previewKind(name: string): FilePreviewKind {
  const ext = extensionOf(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  // html 单独一类：它既能看源码也能在沙箱里渲染，右侧栏据此给「切换视图」。
  if (ext === "html" || ext === "htm") return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  const office = OFFICE_EXT[ext];
  if (office) return office;
  if (TEXT_EXT.has(ext) || ext === "") return "text";
  return "text";
}

export function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return "";
  return base.slice(idx + 1).toLowerCase();
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface LineCountPart {
  text: string;
  tone: string;
}

/**
 * Git 数字徽标的分段（每段自带色调，调用方逐段渲染）。
 *
 * 只增给一段绿色 `+N`、只删给一段红色 `−N`，**有增有删仍是两段各自着色**，
 * 不能合并成一个灰色数字：灰色既读不出哪边是加、哪边是删，也和「无改动」混在一起。
 * 没有改动（两侧都是 0）或没有统计时给空数组，调用方据此不渲染徽标——不要出现 `−0`。
 */
export function lineCountParts(
  counts: { additions: number; deletions: number; binary?: boolean } | undefined,
): LineCountPart[] {
  if (!counts) return [];
  if (counts.binary) return [{ text: "bin", tone: "text-faint" }];
  const parts: LineCountPart[] = [];
  if (counts.additions > 0) parts.push({ text: `+${counts.additions}`, tone: "text-ok" });
  if (counts.deletions > 0) parts.push({ text: `−${counts.deletions}`, tone: "text-danger" });
  return parts;
}

/** 分支/引用展示：`HEAD -> main, origin/main` → 去掉 HEAD 前缀。 */
export function refsLabel(refs: string): string {
  return refs
    .split(",")
    .map((r) => r.trim().replace(/^HEAD -> /, ""))
    .filter(Boolean)
    .join(", ");
}

/** 工作区里的仓库项（与 transport/types 的 GitRepo 同形，这里只依赖最小字段）。 */
export interface RepoRef {
  path: string;
  root: string;
}

/**
 * 选哪个仓库：保持当前选中（只要它还在列表里），否则工作区根（path 为 ""），
 * 再否则第一个。扫描结果可能因为新建/删除仓库而变化，不能直接取第一个。
 */
export function pickRepo(repos: RepoRef[], current: string): string {
  if (current && repos.some((r) => r.root === current)) return current;
  const root = repos.find((r) => r.path === "");
  return (root ?? repos[0])?.root ?? "";
}
