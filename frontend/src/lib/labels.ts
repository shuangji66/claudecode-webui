// 展示层的小型纯函数：会话标题、相对时间、模式名。
import type { Item } from "./model";
import { tr } from "./i18n";
import type { Locale } from "./i18n";

export function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function truncate(s: string, n: number): string {
  const r = Array.from(s.replace(/\s+/g, " ").trim());
  return r.length > n ? `${r.slice(0, n).join("")}…` : r.join("");
}

/** 会话标题：优先用第一条用户消息，没有就用工作区目录名。 */
export function sessionTitle(cwd: string, items: Item[] | undefined, locale: Locale = "zh"): string {
  const first = items?.find((i) => i.kind === "user" && i.text.trim());
  if (first && first.kind === "user") return truncate(first.text, 48);
  return baseName(cwd) || tr(locale, "新会话", "New session");
}

/** 对话标题：自定义标题 > 首条用户消息 > “新对话”。 */
export function conversationTitle(
  title: string | undefined,
  items: Item[] | undefined,
  locale: Locale = "zh",
): string {
  const custom = title?.trim();
  if (custom) return custom;
  const first = items?.find((i) => i.kind === "user" && i.text.trim());
  if (first && first.kind === "user") return truncate(first.text, 48);
  return tr(locale, "新对话", "New chat");
}

/** 相对时间；传 now 便于测试。 */
export function relativeTime(iso: string | undefined, now = Date.now(), locale: Locale = "zh"): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return tr(locale, "刚刚", "just now");
  if (min < 60) return tr(locale, `${min} 分钟前`, `${min} min ago`);
  const hours = Math.floor(min / 60);
  if (hours < 24) return tr(locale, `${hours} 小时前`, `${hours} h ago`);
  const days = Math.floor(hours / 24);
  if (days < 7) return tr(locale, `${days} 天前`, `${days} d ago`);
  return new Date(t).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric" });
}

/** 消息时间 HH:mm。 */
export function clockTime(ts: number, locale: Locale = "zh"): string {
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" });
}

const MODE_LABELS: Record<string, string> = {
  "": "标准模式",
  default: "默认模式",
  acceptEdits: "接受编辑",
  plan: "计划模式",
  dontAsk: "不询问",
  bypassPermissions: "跳过权限",
};

export function permissionLabel(mode: string | undefined, locale: Locale = "zh"): string {
  const key = mode ?? "";
  if (locale === "en") {
    const en: Record<string, string> = {
      "": "Standard",
      default: "Default",
      acceptEdits: "Accept edits",
      plan: "Plan",
      dontAsk: "Don't ask",
      bypassPermissions: "Bypass permissions",
    };
    return en[key] ?? key;
  }
  return MODE_LABELS[key] ?? key ?? "标准模式";
}

export function stateLabel(state: string | undefined, locale: Locale = "zh"): string {
  switch (state) {
    case "busy":
      return tr(locale, "运行中", "Running");
    case "starting":
      return tr(locale, "启动中", "Starting");
    case "ready":
      return tr(locale, "空闲", "Idle");
    case "closed":
      return tr(locale, "已关闭", "Closed");
    default:
      return tr(locale, "未连接", "Disconnected");
  }
}

/**
 * 常见斜杠命令的简短中文说明。
 *
 * CLI 自带的 description 是英文长句（有些还带参数说明），塞进 264px 的菜单里只能
 * 看到「Use this skill wheneve…」。这里给常用命令一句中文短说明，没收录的回落到
 * CLI 原文（英文环境下本来就该用原文）。
 */
const COMMAND_LABELS: Record<string, string> = {
  compact: "压缩对话上下文",
  model: "切换本会话模型",
  clear: "清空当前会话",
  help: "查看帮助",
  init: "生成项目说明文件",
  review: "审查改动",
  "pr-comments": "拉取 PR 评论",
  cost: "查看用量与花费",
  usage: "查看用量",
  status: "查看会话状态",
  doctor: "环境自检",
  login: "登录账号",
  logout: "退出登录",
  memory: "编辑记忆文件",
  config: "打开配置",
  agents: "管理子代理",
  hooks: "管理钩子",
  mcp: "管理 MCP 服务",
  permissions: "管理权限规则",
  plan: "切换计划模式",
  resume: "恢复历史对话",
  export: "导出对话",
  rewind: "回退到之前的状态",
  todos: "查看待办",
  vim: "切换 vim 编辑模式",
  context: "查看上下文占用",
  bug: "反馈问题",
  "release-notes": "查看更新日志",
};

/** 命令在菜单里的一句说明：中文优先，没收录的用 CLI 自带描述（由 UI 截断）。 */
export function commandDescription(name: string, description: string | undefined, locale: Locale = "zh"): string {
  if (locale !== "en") {
    const zh = COMMAND_LABELS[name];
    if (zh) return zh;
  }
  return description ?? "";
}
