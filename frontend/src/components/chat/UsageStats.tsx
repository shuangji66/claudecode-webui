// 输入框下方的用量统计（对齐 DSH 底部那行）。
//
// 只显示 claude CLI 真的给出的数字：上下文 / 缓存命中来自最近一次请求的 usage，
// 窗口来自 result.modelUsage，tok/s 由输出 token ÷ API 耗时算出。
// CLI 没有「步骤数」「实时 tok/s」「官方上下文百分比」，所以这里也不编：
// 步数用工具调用次数，其余都是同一套 usage 数据的换算（见 lib/usage）。

import { useT } from "../../lib/i18n";
import { contextPercent, formatTokens, tokensPerSecond, type UsageSnapshot } from "../../lib/usage";

interface Props {
  snap: UsageSnapshot | undefined;
  turns: number;
  tools: number;
  events: number;
}

export function UsageStats({ snap, turns, tools, events }: Props) {
  const t = useT();
  const tps = snap ? tokensPerSecond(snap.outputTokens ?? 0, snap.apiMs) : undefined;
  const pct = snap ? contextPercent(snap.contextTokens, snap.contextWindow) : undefined;

  const parts: string[] = [];
  if (turns > 0) parts.push(t(`${turns} 轮`, `${turns} turns`));
  if (tools > 0) parts.push(t(`${tools} 工具`, `${tools} tools`));
  if (tps !== undefined) parts.push(`${Math.round(tps)} tok/s`);
  if (pct !== undefined) parts.push(t(`上下文 ${pct}%`, `context ${pct}%`));

  const contextLine =
    snap && snap.contextTokens > 0
      ? t(
          `上下文 ${formatTokens(snap.contextTokens)}${snap.contextWindow ? ` / ${formatTokens(snap.contextWindow)}` : ""}${pct !== undefined ? `（${pct}%）` : ""}`,
          `Context ${formatTokens(snap.contextTokens)}${snap.contextWindow ? ` / ${formatTokens(snap.contextWindow)}` : ""}${pct !== undefined ? ` (${pct}%)` : ""}`,
        )
      : "";
  const cacheLine =
    snap?.cacheHitRate !== undefined ? t(`缓存命中 ${Math.round(snap.cacheHitRate * 100)}%`, `Cache hit ${Math.round(snap.cacheHitRate * 100)}%`) : "";
  const turnLine =
    snap?.outputTokens !== undefined && snap?.apiMs !== undefined
      ? t(`本回合输出 ${snap.outputTokens} tok · API ${(snap.apiMs / 1000).toFixed(2)}s`, `Turn output ${snap.outputTokens} tok · API ${(snap.apiMs / 1000).toFixed(2)}s`)
      : "";
  const eventsLine = events > 0 ? t(`共 ${events} 条事件 · ${tools} 次工具`, `${events} events · ${tools} tools`) : "";
  const title = [contextLine, cacheLine, turnLine, eventsLine].filter(Boolean).join("\n") || undefined;

  // 没有 usage 时只报事件/工具数（老转录里没有 usage，别硬凑 token 数字）。
  if (!snap || parts.length === 0) {
    return <span className="shrink-0 tabular-nums">{eventsLine}</span>;
  }

  return (
    <span className="shrink-0 tabular-nums" title={title}>
      <span className="hidden sm:inline">{parts.join(" · ")}</span>
      {/* 窄屏只留轮数与上下文百分比，别把输入框那一行挤爆。 */}
      <span className="sm:hidden">
        {[turns > 0 ? t(`${turns} 轮`, `${turns} turns`) : "", pct !== undefined ? `${pct}%` : ""].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}
