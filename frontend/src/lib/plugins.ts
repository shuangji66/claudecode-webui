// 插件界面的纯函数：响应兜底、目录查询串、插件 id 拆分。
//
// 单独成模块是为了可测，也为了让 store 只做状态搬运（与 lib/mcpForm.ts 同一套思路）。
import type { PluginsPayload } from "../transport/types";

export const EMPTY_PLUGINS: PluginsPayload = {
  supported: false,
  reason: "",
  home: "",
  installed: [],
  marketplaces: [],
  available_total: 0,
  job: null,
};

/**
 * 响应兜底：数组字段为 null 时前端 .map 会直接白屏。
 *
 * 后端已经保证非 nil，这里防的是「部署了旧后端 / 网关返回了错误体」这类情况。
 */
export function normalizePlugins(p: PluginsPayload | null | undefined): PluginsPayload {
  if (!p) return EMPTY_PLUGINS;
  return {
    supported: p.supported === true,
    reason: p.reason ?? "",
    home: p.home ?? "",
    installed: Array.isArray(p.installed) ? p.installed : [],
    marketplaces: Array.isArray(p.marketplaces) ? p.marketplaces : [],
    available_total: typeof p.available_total === "number" ? p.available_total : 0,
    available_at: p.available_at,
    available_note: p.available_note,
    job: p.job ?? null,
  };
}

/** 插件标识拆成 名字 / 市场；没有 @ 时市场为空串。 */
export function splitPluginID(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id, marketplace: "" };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/** 可安装列表一页多少条：作为 `limit` 发给服务端（目录 3743 条，前端只拿一页）。 */
export const AVAILABLE_PAGE_SIZE = 20;

/** 拼 /api/plugins/available 的查询串（纯函数，方便测试）。 */
export function availableQuery(opts: {
  q?: string;
  market?: string;
  hideInstalled?: boolean;
  offset?: number;
  limit?: number;
}): string {
  const qs = new URLSearchParams();
  const q = (opts.q ?? "").trim();
  if (q) qs.set("q", q);
  if (opts.market) qs.set("market", opts.market);
  if (opts.hideInstalled) qs.set("hide_installed", "1");
  qs.set("offset", String(Math.max(0, opts.offset ?? 0)));
  qs.set("limit", String(opts.limit ?? AVAILABLE_PAGE_SIZE));
  return qs.toString();
}
