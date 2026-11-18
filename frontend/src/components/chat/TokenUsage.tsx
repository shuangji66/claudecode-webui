// Token 消耗入口（对齐 DSH 底栏那颗「数据库图标 + 总量」的胶囊）。
//
// 为什么从上下文弹窗里拆出来：占用回答「窗口还剩多少」（最近一次请求的输入侧），
// 消耗回答「一共花了多少」（这一轮 / 这个会话所有请求之和，含缓存）——长任务里
// 后者能到几百万，摆在占用旁边只会让人把两个数看成同一件事。
//
// 只显示 CLI 真的给出的数字（见 lib/usage）：没有 usage 的老转录什么都不渲染。

import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { formatTokens, tokensPerSecond, type UsageSnapshot } from "../../lib/usage";
import { IconDatabase } from "../common/Icons";
import { POPUP_PANEL, PORTAL_ATTR, useAnchoredPanel, useDismiss } from "../common/Menu";

interface Props {
  snap: UsageSnapshot | undefined;
  turns: number;
  tools: number;
  events: number;
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

const PANEL_WIDTH = 264;
// 本轮 4 行 + 会话 2 行 + 速度/耗时 2 行 + 累计 1 行，三条分隔线。
const PANEL_HEIGHT = 340;

/**
 * 输入框下方居中那颗「图标 + token 总量」。
 *
 * 数字优先用会话累计（这是「总量」）；还没跑完第一轮时退回落本轮消耗，两者都没有
 * （老转录 / 请求全失败）就整颗不渲染——宁可不给，也不要摆一个 0。
 */
export function TokenUsage({ snap, turns, tools, events }: Props) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const pos = useAnchoredPanel(anchor, anchor !== null, PANEL_WIDTH, PANEL_HEIGHT);
  useDismiss(anchor !== null, panelRef, anchor, close);

  const turnInput = snap?.turnInputTokens;
  const turnTotal = (turnInput ?? 0) + (snap?.outputTokens ?? 0);
  const sessionInput = snap?.sessionInputTokens;
  const sessionOutput = snap?.sessionOutputTokens;
  const sessionTotal = (sessionInput ?? 0) + (sessionOutput ?? 0);
  const total = sessionTotal || turnTotal;
  const tps = snap ? tokensPerSecond(snap.genTokens ?? 0, snap.genMs) : undefined;

  if (total <= 0) return null;

  const totals = [
    turns > 0 ? t(`${turns} 轮`, `${turns} turns`) : "",
    tools > 0 ? t(`${tools} 次工具`, `${tools} tool calls`) : "",
    events > 0 ? t(`${events} 条事件`, `${events} events`) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-1 flex justify-center">
      <button
        type="button"
        onClick={(e) => setAnchor((cur) => (cur ? null : e.currentTarget))}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={t(`token 消耗 ${formatTokens(total)}，查看详情`, `Token usage ${formatTokens(total)}, details`)}
        className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] tabular-nums ${
          anchor ? "bg-panel-strong text-ink-2" : "text-faint hover:bg-panel-strong hover:text-ink-2"
        }`}
      >
        <IconDatabase size={13} className="shrink-0" />
        <span>{formatTokens(total)} tok</span>
      </button>

      {anchor &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("token 用量", "Token usage")}
            {...{ [PORTAL_ATTR]: "" }}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className={`${POPUP_PANEL} overflow-y-auto p-2.5`}
          >
            <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] font-medium text-ink">
              <span>{t("token 用量", "Token usage")}</span>
              <span className="tabular-nums">{formatTokens(total)} tok</span>
            </div>

            <div className="space-y-1 text-[11px]">
              <div className="text-[10.5px] text-faint">{t("本轮消耗", "This turn")}</div>
              {turnInput !== undefined && (
                <Row label={t("输入（含缓存）", "Input (cached)")}>{formatTokens(turnInput)}</Row>
              )}
              {snap?.outputTokens !== undefined && (
                <Row label={t("输出", "Output")}>{formatTokens(snap.outputTokens)}</Row>
              )}
              {turnTotal > 0 && <Row label={t("合计", "Total")}>{formatTokens(turnTotal)} tok</Row>}
              {snap?.thinkingTokens !== undefined && (
                <Row label={t("其中思考", "Thinking")}>{formatTokens(snap.thinkingTokens)} tok</Row>
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

            <div className="my-1.5 h-px bg-line" />
            <div className="space-y-1 text-[11px]">
              {tps !== undefined && <Row label={t("生成速度", "Throughput")}>{Math.round(tps)} tok/s</Row>}
              {snap?.apiMs !== undefined && (
                <Row label={t("本回合 API 耗时", "Turn API time")}>{(snap.apiMs / 1000).toFixed(2)}s</Row>
              )}
              {totals && <Row label={t("累计", "Totals")}>{totals}</Row>}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
