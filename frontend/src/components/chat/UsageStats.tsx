// 输入框下方的用量（对齐 DSH 底栏那套）：
//   - 一整块**一个按钮**：轮数 / 会话累计 token / tok/s + 上下文占用圆环与百分比，
//     点哪儿都打开同一个弹层（占用、会话累计、缓存与生成速度都在里面）；
//   - 以前左半边是纯文字、只有圆环能点：想看一眼总用量得先瞄一眼右边那颗小圈，
//     点偏一点就没反应。整块可点之后，那一行本身就是入口。
//
// 只显示 claude CLI 真的给出的数字（换算见 lib/usage）：CLI 没有「步骤数」「官方上下文
// 百分比」，步数用工具调用次数、速度用 Σ输出 ÷ Σ生成耗时（不含首字延迟，见
// lib/usage 的 `throughput`）。

import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import {
  contextPercent,
  formatSpeed,
  formatCacheHit,
  formatTokens,
  sessionTotals,
  throughput,
  type UsageSnapshot,
} from "../../lib/usage";
import { POPUP_PANEL, PORTAL_ATTR, useAnchoredPanel, useDismiss } from "../common/Menu";

/** `useT()` 给出的翻译函数。 */
type Translate = (zh: string, en?: string) => string;

interface SummaryProps {
  snap: UsageSnapshot | undefined;
  turns: number;
  events: number;
}

interface StatsProps {
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
 * 底栏那行文字：轮数 / 会话累计 token / tok/s。
 *
 * 工具数与事件数不在这里——它们在弹层的「累计」里，底栏只留最短的几项。
 *
 * 中间那个总量是**会话累计**（输入含缓存 + 输出），与弹层「合计」同一个数：
 * 它回答的是「这条路花了多少」，与 tok/s（最近几次请求的加权速度）不是一回事。
 * 首轮还没跑完（没有 `result`）时取本回合已发出去请求的即时累计（`sessionTotals`），
 * 否则底栏在整轮里只有一个「1 轮」。
 *
 * **窄屏不折叠**：手机上底部这一行是唯一能看到用量的地方，折叠掉总量与速度等于
 * 「移动端永远看不到这两个数」，与桌面模式对不齐。
 */
function summaryText(snap: UsageSnapshot | undefined, turns: number, events: number, t: Translate): string {
  const tps = throughput(snap);
  const total = sessionTotals(snap).total;

  const parts: string[] = [];
  if (turns > 0) parts.push(t(`${turns} 轮`, `${turns} turns`));
  if (total > 0) parts.push(formatTokens(total));
  if (tps !== undefined) parts.push(`${formatSpeed(tps)} tok/s`);
  if (parts.length > 0) return parts.join(" · ");
  // 没有 usage 时只报事件数（老转录里没有 usage，别硬凑 token 数字）。
  return events > 0 ? t(`共 ${events} 条事件`, `${events} events`) : "";
}

/** 底栏用量文字（不含占用圆环）；`UsageStats` 把它放进那颗按钮里。 */
export function UsageSummary({ snap, turns, events }: SummaryProps) {
  const t = useT();
  return <span className="shrink-0 whitespace-nowrap tabular-nums">{summaryText(snap, turns, events, t)}</span>;
}

const PANEL_WIDTH = 264;
// 占用 2 行 + 会话 2 行 + 缓存 2~3 行 + 速度 1 行 + 累计 1 行，四条分隔线。
const PANEL_HEIGHT = 360;

/**
 * 底栏右侧的用量块：**整块一个按钮**（文字 + 圆环 + 百分比），点开是整份用量明细。
 *
 * 只有一个入口：token 详情不再单独拆一颗按钮（试过，两个入口互相重复）。没有窗口或
 * 占用时不出圈，但**照样可点**——会话累计、缓存与速度都是独立的数，不该因为不知道
 * 上下文窗口就把它们藏起来；连用量都还没有（只有事件计数）时它就不是按钮了。
 */
export function UsageStats({ snap, turns, tools, events }: StatsProps) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const pos = useAnchoredPanel(anchor, anchor !== null, PANEL_WIDTH, PANEL_HEIGHT);
  useDismiss(anchor !== null, panelRef, anchor, close);

  const text = summaryText(snap, turns, events, t);
  const pct = snap ? contextPercent(snap.contextTokens, snap.contextWindow) : undefined;
  // 会话累计与本回合的即时累计合在一起（见 lib/usage 的 sessionTotals）：
  // 首轮 `result` 还没到、或者中途接进来的会话，都能报出合计 / 输入 / 输出。
  const session = sessionTotals(snap);
  const tps = throughput(snap);
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
  // 还没有任何用量（老转录 / 刚打开还没跑）：只剩事件计数，没有可点开的东西。
  if (!snap) return text ? <UsageSummary snap={snap} turns={turns} events={events} /> : null;
  // 一句话都报不出来、也没有占用圈（快照里只有一个没有窗口的上下文数）：别摆一颗
  // 看不见的按钮——点开是个空弹层。
  if (!text && pct === undefined) return null;

  const contextLabel = pct !== undefined ? t(`上下文占用 ${pct}%`, `Context usage ${pct}%`) : "";
  const label = [text, contextLabel].filter(Boolean).join(" · ");
  const barTone = pct === undefined ? "" : pct >= 85 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-brand";

  return (
    <span className="flex shrink-0 items-center tabular-nums">
      <button
        type="button"
        onClick={(e) => setAnchor((cur) => (cur ? null : e.currentTarget))}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={label || t("用量", "Usage")}
        className="-mx-1 flex items-center gap-2 rounded-full px-1 hover:bg-panel-strong"
      >
        {text && <UsageSummary snap={snap} turns={turns} events={events} />}
        {pct !== undefined && (
          <span className="flex items-center gap-1">
            <UsageRing percent={pct} />
            <span>{pct}%</span>
          </span>
        )}
      </button>

      {anchor &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("用量", "Usage")}
            {...{ [PORTAL_ATTR]: "" }}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className={`${POPUP_PANEL} overflow-y-auto p-2.5`}
          >
            {pct !== undefined && (
              <>
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
                </div>
              </>
            )}

            {/* 一块整体：上面是会话累计（合计 / 输入 / 输出），下面是最近一次请求的缓存明细
                （未命中 / 读取 / 写入 / 命中）。中间不切分隔线，也不挂分组标题。 */}
            <div className={`${pct !== undefined ? "mt-1.5 border-t border-line pt-1.5" : ""} space-y-1 text-[11px]`}>
              {session.total > 0 && (
                <>
                  <Row label={t("合计", "Total")}>{formatTokens(session.total)} tok</Row>
                  <Row label={t("输入", "Input")}>{formatTokens(session.input)}</Row>
                  <Row label={t("输出", "Output")}>{formatTokens(session.output)}</Row>
                </>
              )}
              {snap.inputTokens !== undefined && (
                <Row label={t("未命中缓存", "Uncached")}>{formatTokens(snap.inputTokens)}</Row>
              )}
              {cacheRead ? <Row label={t("缓存读取", "From cache")}>{formatTokens(cacheRead)}</Row> : null}
              {cacheWrite ? <Row label={t("缓存写入", "Cache write")}>{formatTokens(cacheWrite)}</Row> : null}
              {cacheHit !== undefined && (
                <Row label={t("缓存命中", "Cache hit")}>{formatCacheHit(cacheHit)}</Row>
              )}
            </div>

            {(tps !== undefined || totals) && (
              <>
                <div className="my-1.5 h-px bg-line" />
                <div className="space-y-1 text-[11px]">
                  {tps !== undefined && (
                    <Row label={t("生成速度", "Throughput")}>{formatSpeed(tps)} tok/s</Row>
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
