// 输入框下方的用量统计（对齐 DSH 底部那行）。
//
// 只显示 claude CLI 真的给出的数字：上下文 / 缓存命中来自最近一次请求的 usage，
// 窗口来自 result.modelUsage，tok/s 由输出 token ÷ API 耗时算出。
// CLI 没有「步骤数」「实时 tok/s」「官方上下文百分比」，所以这里也不编：
// 步数用工具调用次数，其余都是同一套 usage 数据的换算（见 lib/usage）。
//
// 上下文圈和百分比是**按钮**：点一下弹详情（对齐 DSH），不再只靠 title 悬停——
// 悬停在触屏上根本拿不到，而且一长串数字挤在 tooltip 里也读不完。

import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { contextPercent, formatTokens, tokensPerSecond, type UsageSnapshot } from "../../lib/usage";
import { POPUP_PANEL, PORTAL_ATTR, useAnchoredPanel, useDismiss } from "../common/Menu";

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

/** 详情里的一行：左边小字标签，右边数字。 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-faint">{label}</span>
      <span className="min-w-0 truncate text-right tabular-nums text-ink">{children}</span>
    </div>
  );
}

const PANEL_WIDTH = 232;

export function UsageStats({ snap, turns, tools, events }: Props) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const pos = useAnchoredPanel(anchor, anchor !== null, PANEL_WIDTH, 210);
  useDismiss(anchor !== null, panelRef, anchor, close);

  const tps = snap ? tokensPerSecond(snap.outputTokens ?? 0, snap.apiMs) : undefined;
  const pct = snap ? contextPercent(snap.contextTokens, snap.contextWindow) : undefined;

  // 顶栏那行只放最短的几项：轮数 / 工具数 / tok/s，细节留给点开的详情。
  const parts: string[] = [];
  if (turns > 0) parts.push(t(`${turns} 轮`, `${turns} turns`));
  if (tools > 0) parts.push(t(`${tools} 工具`, `${tools} tools`));
  if (tps !== undefined) parts.push(`${Math.round(tps)} tok/s`);

  const totals = [
    turns > 0 ? t(`${turns} 轮`, `${turns} turns`) : "",
    tools > 0 ? t(`${tools} 次工具`, `${tools} tool calls`) : "",
    events > 0 ? t(`${events} 条事件`, `${events} events`) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // 没有 usage 时只报事件/工具数（老转录里没有 usage，别硬凑 token 数字）。
  if (!snap || parts.length === 0) {
    const fallback = events > 0 ? t(`共 ${events} 条事件 · ${tools} 次工具`, `${events} events · ${tools} tools`) : "";
    return <span className="shrink-0 tabular-nums">{fallback}</span>;
  }

  const barTone = (pct ?? 0) >= 85 ? "bg-danger" : (pct ?? 0) >= 70 ? "bg-warn" : "bg-brand";

  return (
    <span className="flex shrink-0 items-center gap-2 tabular-nums">
      <span className="hidden sm:inline">{parts.join(" · ")}</span>
      {/* 窄屏只留轮数与上下文圈，别把输入框那一行挤爆。 */}
      {turns > 0 && <span className="sm:hidden">{t(`${turns} 轮`, `${turns} turns`)}</span>}
      {pct !== undefined && (
        <button
          type="button"
          onClick={(e) => setAnchor((cur) => (cur ? null : e.currentTarget))}
          aria-haspopup="dialog"
          aria-expanded={anchor !== null}
          aria-label={t(`上下文占用 ${pct}%`, `Context usage ${pct}%`)}
          className="-mx-1 flex items-center gap-1 rounded-full px-1 hover:bg-panel-strong"
        >
          <UsageRing percent={pct} />
          <span>{pct}%</span>
        </button>
      )}

      {anchor &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("用量详情", "Usage details")}
            {...{ [PORTAL_ATTR]: "" }}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className={`${POPUP_PANEL} overflow-y-auto p-2.5`}
          >
            <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] font-medium text-ink">
              <span>{t("上下文占用", "Context usage")}</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-panel-strong">
              <div className={`h-full rounded-full ${barTone}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="space-y-1 text-[11px]">
              <Row label={t("已用", "Used")}>
                {formatTokens(snap.contextTokens)}
                {snap.contextWindow ? ` / ${formatTokens(snap.contextWindow)}` : ""}
              </Row>
              {snap.cacheHitRate !== undefined && (
                <Row label={t("缓存命中", "Cache hit")}>{Math.round(snap.cacheHitRate * 100)}%</Row>
              )}
              {snap.outputTokens !== undefined && (
                <Row label={t("本回合输出", "Turn output")}>{formatTokens(snap.outputTokens)} tok</Row>
              )}
              {snap.apiMs !== undefined && (
                <Row label={t("API 耗时", "API time")}>{(snap.apiMs / 1000).toFixed(2)}s</Row>
              )}
              {tps !== undefined && <Row label={t("生成速度", "Throughput")}>{Math.round(tps)} tok/s</Row>}
              {totals && <Row label={t("累计", "Totals")}>{totals}</Row>}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
