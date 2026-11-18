// 输入框下方的用量（对齐 DSH 底栏那套）：
//   - `UsageSummary`：轮数 / 工具数 / tok/s 的纯文字，细节留给点开的弹层；
//   - `UsageStats`：上下文占用的圆环 + 百分比，点开是**同一个**弹层——占用、会话累计、
//     缓存与生成速度都在里面。只有一个入口：token 详情不再单独拆一颗按钮（试过，两个
//     入口互相重复）。本轮消耗只出现在回答下面那行小字里，弹层不重复报。
//
// 只显示 claude CLI 真的给出的数字（换算见 lib/usage）：CLI 没有「步骤数」「官方上下文
// 百分比」，步数用工具调用次数、tok/s 用最近一次请求的输出 ÷ 它自己的生成耗时。

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

/**
 * 底栏那行文字：轮数 / 工具数 / tok/s。
 *
 * 窄屏只留轮数（输入框那一行本来就挤），其余数字在弹层的「累计」里也能看到。
 */
export function UsageSummary({ snap, turns, tools, events }: Props) {
  const t = useT();
  const tps = snap ? tokensPerSecond(snap.genTokens ?? 0, snap.genMs) : undefined;

  const parts: string[] = [];
  if (turns > 0) parts.push(t(`${turns} 轮`, `${turns} turns`));
  if (tools > 0) parts.push(t(`${tools} 工具`, `${tools} tools`));
  if (tps !== undefined) parts.push(`${Math.round(tps)} tok/s`);

  // 没有 usage 时只报事件/工具数（老转录里没有 usage，别硬凑 token 数字）。
  if (!snap || parts.length === 0) {
    const fallback = events > 0 ? t(`共 ${events} 条事件 · ${tools} 次工具`, `${events} events · ${tools} tools`) : "";
    return <span className="shrink-0 tabular-nums">{fallback}</span>;
  }

  return (
    <span className="shrink-0 tabular-nums">
      <span className="hidden sm:inline">{parts.join(" · ")}</span>
      {turns > 0 && <span className="sm:hidden">{t(`${turns} 轮`, `${turns} turns`)}</span>}
    </span>
  );
}

const PANEL_WIDTH = 264;
// 占用 2 行 + 会话 2 行 + 缓存 2~3 行 + 速度 1 行 + 累计 1 行，四条分隔线。
const PANEL_HEIGHT = 360;

interface StatsProps {
  snap: UsageSnapshot | undefined;
  turns: number;
  tools: number;
  events: number;
}

/** 上下文占用的圆环 + 百分比；点开是整份用量明细（占用 / 会话累计 / 缓存 / 速度 / 轮次）。 */
export function UsageStats({ snap, turns, tools, events }: StatsProps) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const pos = useAnchoredPanel(anchor, anchor !== null, PANEL_WIDTH, PANEL_HEIGHT);
  useDismiss(anchor !== null, panelRef, anchor, close);

  const pct = snap ? contextPercent(snap.contextTokens, snap.contextWindow) : undefined;
  // tok/s 只认「最近一次请求的输出 ÷ 它自己的生成耗时」：整轮平均会把首字延迟摊进分母。
  const tps = snap ? tokensPerSecond(snap.genTokens ?? 0, snap.genMs) : undefined;
  const sessionInput = snap?.sessionInputTokens;
  const sessionOutput = snap?.sessionOutputTokens;
  const sessionTotal = (sessionInput ?? 0) + (sessionOutput ?? 0);
  const cacheRead = snap?.cacheReadTokens;
  const cacheWrite = snap?.cacheCreationTokens;
  const cacheHit = snap?.cacheHitRate;
  const totals = [
    turns > 0 ? t(`${turns} 轮`, `${turns} turns`) : "",
    tools > 0 ? t(`${tools} 次工具`, `${tools} tool calls`) : "",
    events > 0 ? t(`${events} 条事件`, `${events} events`) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!snap || pct === undefined) return null;
  const barTone = pct >= 85 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-brand";

  return (
    <span className="flex shrink-0 items-center tabular-nums">
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

      {anchor &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("上下文占用", "Context usage")}
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
              {snap.inputTokens !== undefined && (
                <Row label={t("新输入", "New input")}>{formatTokens(snap.inputTokens)}</Row>
              )}
            </div>

            {sessionTotal > 0 && (
              <>
                <div className="my-1.5 h-px bg-line" />
                <div className="space-y-1 text-[11px]">
                  <div className="text-[10.5px] text-faint">{t("会话累计消耗", "Session total")}</div>
                  <Row label={t("合计", "Total")}>{formatTokens(sessionTotal)} tok</Row>
                  <Row label={t("输入 / 输出", "Input / output")}>
                    {`${formatTokens(sessionInput ?? 0)} / ${formatTokens(sessionOutput ?? 0)}`}
                  </Row>
                </div>
              </>
            )}

            {(cacheRead || cacheWrite || cacheHit !== undefined) && (
              <>
                <div className="my-1.5 h-px bg-line" />
                {/* 这三行就是最近一次请求的缓存明细，不再单独挂标题（占一行又没信息量）。 */}
                <div className="space-y-1 text-[11px]">
                  {cacheRead ? <Row label={t("缓存读取", "From cache")}>{formatTokens(cacheRead)}</Row> : null}
                  {cacheWrite ? <Row label={t("缓存写入", "Cache write")}>{formatTokens(cacheWrite)}</Row> : null}
                  {cacheHit !== undefined && (
                    <Row label={t("缓存命中", "Cache hit")}>{Math.round(cacheHit * 100)}%</Row>
                  )}
                </div>
              </>
            )}

            {(tps !== undefined || totals) && (
              <>
                <div className="my-1.5 h-px bg-line" />
                <div className="space-y-1 text-[11px]">
                  {tps !== undefined && (
                    <Row label={t("生成速度", "Throughput")}>{Math.round(tps)} tok/s</Row>
                  )}
                  {totals && <Row label={t("累计", "Totals")}>{totals}</Row>}
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
