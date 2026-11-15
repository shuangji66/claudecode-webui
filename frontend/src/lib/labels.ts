// 展示层的小型纯函数：会话标题、相对时间、模式名。
import type { Item } from "./model";

export function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function truncate(s: string, n: number): string {
  const r = Array.from(s.replace(/\s+/g, " ").trim());
  return r.length > n ? `${r.slice(0, n).join("")}…` : r.join("");
}

/** 会话标题：优先用第一条用户消息，没有就用工作区目录名。 */
export function sessionTitle(cwd: string, items: Item[] | undefined): string {
  const first = items?.find((i) => i.kind === "user" && i.text.trim());
  if (first && first.kind === "user") return truncate(first.text, 48);
  return baseName(cwd) || "新会话";
}

/** 相对时间；传 now 便于测试。 */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 消息时间 HH:mm。 */
export function clockTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

const MODE_LABELS: Record<string, string> = {
  "": "标准模式",
  default: "默认模式",
  acceptEdits: "接受编辑",
  plan: "计划模式",
  dontAsk: "不询问",
  bypassPermissions: "跳过权限",
};

export function permissionLabel(mode: string | undefined): string {
  return MODE_LABELS[mode ?? ""] ?? mode ?? "标准模式";
}

export function stateLabel(state: string | undefined): string {
  switch (state) {
    case "busy":
      return "运行中";
    case "starting":
      return "启动中";
    case "ready":
      return "空闲";
    case "closed":
      return "已关闭";
    default:
      return "未连接";
  }
}
