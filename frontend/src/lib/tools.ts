// 工具卡片的「一行摘要」与分组统计。
//
// 「紧凑」模式下每个工具调用只占一行（图标 + 工具名 + 摘要 + 状态），
// 摘要必须从工具入参里挑出最有信息量的那个字段：命令、文件路径、URL、搜索词。
// 工具集会随 CLI 版本漂移，所以这里必须对未知工具兜底，不能返回空行——
// 空行等于用户看不出这一步做了什么。
import type { ToolItem } from "./model";

/** 摘要的长度上限：真正截断由 CSS 做，这里只防止把整段文件内容塞进 DOM。 */
const SUMMARY_MAX = 160;

/**
 * 工具名的人话标题：紧凑行与卡片标题共用这一份。
 *
 * 中文给「在做什么」——一行 `Bash` 对着中文界面什么也说明不了；英文**原样回工具名**
 * （`Bash` / `Read` 就是最短的说明，翻成 "Run command" 反而和官方文档对不上）。
 * 未收录的工具（CLI 版本漂移带来的新工具、MCP 的 `mcp__server__tool`）回落原名，
 * 绝不返回空串：标题空了整行看起来就只剩一个摘要，分不出这步在干什么。
 * 名字表只收「工具语义稳定」的那些，别把 MCP 工具名往里塞。
 */
const TOOL_LABELS: Record<string, string> = {
  Read: "读取文件",
  NotebookRead: "读取笔记本",
  Write: "写入文件",
  Edit: "编辑文件",
  MultiEdit: "批量编辑文件",
  NotebookEdit: "编辑笔记本",
  LS: "列出目录",
  Glob: "查找文件",
  Grep: "搜索内容",
  Bash: "运行命令",
  BashOutput: "读取命令输出",
  KillShell: "结束命令",
  KillBash: "结束命令",
  WebSearch: "搜索网页",
  WebFetch: "访问网页",
  Skill: "调用技能",
  TodoWrite: "更新计划",
  TaskCreate: "新建任务",
  TaskUpdate: "更新任务",
  TaskList: "列出任务",
  TaskGet: "查看任务",
};

/** 工具显示名；`t` 就是 `useT()` 给的那个（中文 / 英文双串）。 */
export function toolLabel(name: string, t: (zh: string, en?: string) => string): string {
  const zh = TOOL_LABELS[name];
  return zh ? t(zh, name) : name;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/**
 * 紧凑模式下工具行标题后面那串摘要。未知工具回落到「第一个字符串参数」。
 *
 * 出口统一截断：`Bash` 的整条命令、`ExitPlanMode` 的计划首行、`Grep` 的模式都是
 * 用户/模型给的原文，一条 `python -c "…"` 能有几万字符——CSS 的 truncate 只是视觉
 * 截断，文本照样整段进 DOM 与可访问性树。
 */
export function toolSummary(item: ToolItem): string {
  return clip(rawToolSummary(item));
}

function rawToolSummary(item: ToolItem): string {
  const input = fields(item.input);
  const path = text(input.file_path) || text(input.path) || text(input.notebook_path);

  switch (item.name) {
    case "Bash":
    case "BashOutput":
      return firstLine(text(input.command));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path;
    case "LS":
      return path || ".";
    case "Glob":
    case "Grep":
      return join(text(input.pattern), path);
    case "WebFetch":
      return text(input.url);
    case "WebSearch":
      return text(input.query);
    case "Agent":
    case "Task":
      return text(input.description) || firstLine(text(input.prompt));
    // Tasks API：标题是这里的全部信息（结果里的 id 不占摘要位）。
    case "TaskCreate":
      return text(input.subject) || text(input.description);
    case "TaskUpdate":
      return join(text(input.taskId) ? `#${text(input.taskId)}` : "", text(input.status));
    case "TaskGet":
      return text(input.taskId) ? `#${text(input.taskId)}` : "";
    case "TaskList":
      return "";
    // 计划模式：一行摘要取计划里第一句正文（跳过 Markdown 标题）。
    case "ExitPlanMode": {
      const plan = text(input.plan);
      const line = plan
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "" && !l.startsWith("#"));
      return line ?? firstLine(plan);
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return todos.length > 0 ? `[${todos.length}]` : "";
    }
    case "Skill":
      return text(input.skill) || text(input.command);
    // 提问：摘要取第一道题的正文（一次调用可能问 2–4 道题）。
    case "AskUserQuestion": {
      const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
      return first && typeof first === "object" ? text((first as Record<string, unknown>).question) : "";
    }
    default:
      return fallback(input);
  }
}

function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a} · ${b}`;
}

/**
 * 未知工具的兜底摘要：第一个字符串参数 → 数组参数的长度 → 紧凑 JSON。
 * Write 之类的长内容已经在上面按工具名处理掉了，这里只是最后一道门帘。
 */
function fallback(input: Record<string, unknown>): string {
  const values = Object.values(input);
  for (const value of values) {
    const s = text(value);
    if (s) return clip(firstLine(s));
  }
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return `[${value.length}]`;
  }
  if (values.length === 0) return "";
  try {
    return clip(JSON.stringify(input) ?? "");
  } catch {
    return "";
  }
}

function clip(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;
}
