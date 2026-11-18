// 输入框下方的统计（对齐 DSH 底栏那套）：
//   - `UsageSummary`：轮数 / 工具数 / tok/s 的纯文字，细节留给点开的弹层；
//   - `ContextUsage`：上下文占用的圆环 + 百分比，点开只看「窗口还剩多少」。
// token 消耗（本轮 / 会话累计）在 `TokenUsage.tsx`，居中放在输入框下面——
// 占用是「还剩多少」，消耗是「花了多少」，两个问题的入口不该挤在同一个按钮上。
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
 * 窄屏只留轮数（输入框那一行本来就挤），其余数字在 token 详情的「累计」里也能看到。
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

const PANEL_WIDTH = 236;
// 只放占用相关的 5 行（已用 / 新输入 / 缓存读取 / 缓存写入 / 缓存命中）。
const PANEL_HEIGHT = 220;

/** 上下文占用：圆环 + 百分比，点开是「窗口还剩多少」的明细（消耗在 TokenUsage 里）。 */
export function ContextUsage({ snap }: { snap: UsageSnapshot | undefined }) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const pos = useAnchoredPanel(anchor, anchor !== null, PANEL_WIDTH, PANEL_HEIGHT);
  useDismiss(anchor !== null, panelRef, anchor, close);

  const pct = snap ? contextPercent(snap.contextTokens, snap.contextWindow) : undefined;
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
              {snap.cacheReadTokens ? (
                <Row label={t("缓存读取", "From cache")}>{formatTokens(snap.cacheReadTokens)}</Row>
              ) : null}
              {snap.cacheCreationTokens ? (
                <Row label={t("缓存写入", "Cache write")}>{formatTokens(snap.cacheCreationTokens)}</Row>
              ) : null}
              {snap.cacheHitRate !== undefined && (
                <Row label={t("缓存命中", "Cache hit")}>{Math.round(snap.cacheHitRate * 100)}%</Row>
              )}
            </div>
            <div className="mt-2 text-[10.5px] leading-relaxed text-faint">
              {t(
                "这是最近一次请求送出去的输入侧 token，也就是下一轮要发的上下文。",
                "Input side of the latest request — what the next turn sends as context.",
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
