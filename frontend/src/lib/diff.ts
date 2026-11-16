// Edit 工具的展示逻辑：把协议里能拿到的两种形态统一成行级 diff。
//
// 形态一（首选）：tool_result 附带的结构化补丁 structuredPatch，hunk 内的 lines
//   已带前缀（"+"新增 / "-"删除 / " "上下文）。
// 形态二（兜底）：tool_use 的 input 里只有 old_string / new_string。
// 两者都没有时返回 null，由调用方降级到通用卡片。

export type DiffLineType = "add" | "del" | "ctx" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
}

interface Hunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: string[];
}

function collectFromPatch(hunks: Hunk[]): DiffResult {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    if (typeof h.oldStart === "number") {
      lines.push({
        type: "hunk",
        text: `@@ -${h.oldStart},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`,
      });
    }
    for (const raw of h.lines ?? []) {
      if (raw.startsWith("+")) {
        added += 1;
        lines.push({ type: "add", text: raw.slice(1) });
      } else if (raw.startsWith("-")) {
        removed += 1;
        lines.push({ type: "del", text: raw.slice(1) });
      } else {
        lines.push({ type: "ctx", text: raw.replace(/^ /, "") });
      }
    }
  }
  return { lines, added, removed };
}

function collectFromInput(input: unknown): DiffResult | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const oldStr = obj.old_string;
  const newStr = obj.new_string;
  if (typeof oldStr !== "string" || typeof newStr !== "string") return null;

  const lines: DiffLine[] = [];
  const olds = oldStr.split("\n");
  const news = newStr.split("\n");
  for (const l of olds) lines.push({ type: "del", text: l });
  for (const l of news) lines.push({ type: "add", text: l });
  return { lines, added: news.length, removed: olds.length };
}

/** Write 的输入是 file_path/content：整段内容都算新增。 */
export function writeDiff(input: unknown): DiffResult | null {
  if (!input || typeof input !== "object") return null;
  const content = (input as Record<string, unknown>).content;
  if (typeof content !== "string") return null;
  const lines = content.replace(/\n$/, "").split("\n");
  return { lines: lines.map((text) => ({ type: "add" as const, text })), added: lines.length, removed: 0 };
}

/** 构造 diff；无法构造时返回 null。 */
export function buildDiff(input: unknown, structured: unknown): DiffResult | null {
  if (structured && typeof structured === "object") {
    const patch = (structured as Record<string, unknown>).structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) {
      return collectFromPatch(patch as Hunk[]);
    }
  }
  return collectFromInput(input);
}

/** Edit 的标题摘要：路径 + 增删行数。 */
export function editSummary(input: unknown, diff: DiffResult | null): string {
  const path =
    input && typeof input === "object" && typeof (input as Record<string, unknown>).file_path === "string"
      ? String((input as Record<string, unknown>).file_path)
      : "编辑文件";
  if (!diff) return path;
  return `${path}  +${diff.added} −${diff.removed}`;
}
