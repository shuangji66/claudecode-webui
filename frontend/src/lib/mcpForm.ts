// MCP 表单与展示的纯函数（设置页用）。
//
// 单独成模块是为了可测：把「每行一个参数」「KEY=VALUE 的环境变量」「一行摘要」
// 这类容易写错的转换从组件里拿出来，组件只负责渲染与提交。
import type { McpServer } from "../transport/types";

/** 服务名规则与后端一致：它会成为配置里的 key 与工具名前缀 mcp__<name>__<tool>。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 参数输入框：一行一个，忽略空行；顺序原样保留（`-y` 必须在包名前面）。 */
export function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 参数回填：一行一个，编辑时不会因为空格被拆错。 */
export function formatArgs(args: string[] | undefined): string {
  return (args ?? []).join("\n");
}

/**
 * KEY=VALUE 文本 → 键值表。
 *
 * 返回 invalid 而不是抛错：界面上要能把「哪几行没看懂」标出来，同时让其余行先保存。
 * 值里的等号是允许的（token 里常有），所以只按第一个等号切。
 */
export function parsePairs(text: string): { pairs: Record<string, string>; invalid: string[] } {
  const pairs: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      invalid.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalid.push(line);
      continue;
    }
    pairs[key] = line.slice(eq + 1).trim();
  }
  return { pairs, invalid };
}

/** 键值表 → 文本（按键名排序，回填结果稳定）。 */
export function formatPairs(map: Record<string, string> | undefined): string {
  if (!map) return "";
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${map[k]}`)
    .join("\n");
}

/** 一行摘要：`stdio · npx -y @playwright/mcp`、`http · https://…`。 */
export function summarize(s: McpServer): string {
  if (s.type === "stdio") {
    return [s.command ?? "", ...(s.args ?? [])].filter(Boolean).join(" ");
  }
  return s.url ?? "";
}

/**
 * 提交前的前端预校验，规则与后端 Normalize 一致。
 *
 * 后端仍然会再校验一遍：这里只负责把「明显不完整」变成一句人话，
 * 不必等一次往返。返回空串表示通过。
 */
export function validateDraft(d: {
  name: string;
  type: string;
  command: string;
  url: string;
}): "name" | "command" | "url" | "" {
  if (!NAME_RE.test(d.name.trim())) return "name";
  if (d.type === "stdio") return d.command.trim() ? "" : "command";
  const url = d.url.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) return "url";
  return "";
}
