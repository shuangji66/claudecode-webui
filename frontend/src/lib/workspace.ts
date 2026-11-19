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
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      out.push({ kind: "meta", text: raw });
      continue;
    }
    // `---` / `+++` 只在 hunk 外是文件头；hunk 内它们是内容行（例如新增一行 `++ foo`
    // 在 diff 里就是 `+++ foo`），不能无条件当 meta。
    if (!inHunk && (raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ "))) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("\\ No newline")) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("new file mode ") || raw.startsWith("deleted file mode ") || raw.startsWith("similarity index ") ||
        raw.startsWith("rename from ") || raw.startsWith("rename to ") || raw.startsWith("old mode ") || raw.startsWith("new mode ")) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (inHunk) {
      if (raw.startsWith("+")) {
        out.push({ kind: "add", text: raw.slice(1), newNo });
        newNo += 1;
      } else if (raw.startsWith("-")) {
        out.push({ kind: "del", text: raw.slice(1), oldNo });
        oldNo += 1;
      } else if (raw.startsWith(" ")) {
        out.push({ kind: "ctx", text: raw.slice(1), oldNo, newNo });
        oldNo += 1;
        newNo += 1;
      } else if (raw === "") {
        // diff 末尾的空行不是内容。
      } else {
        out.push({ kind: "ctx", text: raw, oldNo, newNo });
        oldNo += 1;
        newNo += 1;
      }
      continue;
    }
    // 未跟踪文件的伪 diff 没有 hunk，整篇都是新增行。
    if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1) });
    else if (raw !== "") out.push({ kind: "meta", text: raw });
  }
  return out;
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

/** Git 数字徽标的显示文本：二进制/无统计返回空串，0 也如实显示。 */
export function lineCountLabel(counts: { additions: number; deletions: number; binary?: boolean } | undefined): string {
  if (!counts) return "";
  if (counts.binary) return "bin";
  return `+${counts.additions} −${counts.deletions}`;
}

/** 行数徽标的色调（只加不减为绿、只删为红、混合为中性）。 */
export function lineCountTone(counts: { additions: number; deletions: number; binary?: boolean } | undefined): string {
  if (!counts || counts.binary) return "text-faint";
  if (counts.additions > 0 && counts.deletions === 0) return "text-ok";
  if (counts.deletions > 0 && counts.additions === 0) return "text-danger";
  return "text-muted";
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
