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

/**
 * 上下文占用的小圈（参照 DSH 底栏那个环形）。
 *
 * 用 stroke-dashoffset 画弧：周长做 dasharray，占用比例做 offset，从 12 点方向顺时针。
 * 颜色按水位分级——超过 70% 转琥珀、85% 转红，让「快满了」在余光里就能看见。
 */
function UsageRing({ percent }: { percent: number }) {
  const r = 9;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);
  const tone = percent >= 85 ? "text-danger" : percent >= 70 ? "text-warn" : "text-ink-2";
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r={r} fill="none" strokeWidth="3" className="stroke-line-strong" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 12 12)"
        className={`stroke-current ${tone}`}
      />
    </svg>
  );
}

export function UsageStats({ snap, turns, tools, events }: Props) {
  const t = useT();
  const tps = snap ? tokensPerSecond(snap.outputTokens ?? 0, snap.apiMs) : undefined;
  const pct = snap ? contextPercent(snap.contextTokens, snap.contextWindow) : undefined;

  const parts: string[] = [];
  if (turns > 0) parts.push(t(`${turns} 轮`, `${turns} turns`));
  if (tools > 0) parts.push(t(`${tools} 工具`, `${tools} tools`));
  if (tps !== undefined) parts.push(`${Math.round(tps)} tok/s`);

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
    <span className="flex shrink-0 items-center gap-2 tabular-nums" title={title}>
      <span className="hidden sm:inline">{parts.join(" · ")}</span>
      {/* 窄屏只留轮数与上下文圈，别把输入框那一行挤爆。 */}
      {turns > 0 && <span className="sm:hidden">{t(`${turns} 轮`, `${turns} turns`)}</span>}
      {pct !== undefined && (
        <span className="flex items-center gap-1" aria-label={t(`上下文占用 ${pct}%`, `Context usage ${pct}%`)}>
          <UsageRing percent={pct} />
          <span>{pct}%</span>
        </span>
      )}
    </span>
  );
}
