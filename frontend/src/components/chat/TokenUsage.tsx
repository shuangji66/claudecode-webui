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

const PANEL_WIDTH = 248;
// 会话 2 行 + 缓存 3 行 + 速度 1 行，两条分隔线。
const PANEL_HEIGHT = 240;

/**
 * 输入框下方居中那颗「图标 + token 总量」。
 *
 * 数字优先用会话累计（这是「总量」）；还没跑完第一轮时退回落本轮消耗，两者都没有
 * （老转录 / 请求全失败）就整颗不渲染——宁可不给，也不要摆一个 0。
 */
export function TokenUsage({ snap }: Props) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const pos = useAnchoredPanel(anchor, anchor !== null, PANEL_WIDTH, PANEL_HEIGHT);
  useDismiss(anchor !== null, panelRef, anchor, close);

  const sessionInput = snap?.sessionInputTokens;
  const sessionOutput = snap?.sessionOutputTokens;
  const sessionTotal = (sessionInput ?? 0) + (sessionOutput ?? 0);
  // 会话累计还没落（第一轮进行中）时，退回落本轮消耗——弹层里也如实标成「本轮」。
  const turnInput = snap?.turnInputTokens;
  const turnTotal = (turnInput ?? 0) + (snap?.outputTokens ?? 0);
  const total = sessionTotal || turnTotal;
  const tps = snap ? tokensPerSecond(snap.genTokens ?? 0, snap.genMs) : undefined;
  // 缓存三项是「最近一次请求」的数（result 的累计值里没有命中率），单独一段说清楚。
  const cacheRead = snap?.cacheReadTokens;
  const cacheWrite = snap?.cacheCreationTokens;
  const cacheHit = snap?.cacheHitRate;

  if (total <= 0) return null;

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
              <div className="text-[10.5px] text-faint">
                {sessionTotal > 0 ? t("会话累计消耗", "Session total") : t("本轮消耗", "This turn")}
              </div>
              <Row label={t("输入 / 输出", "Input / output")}>
                {sessionTotal > 0
                  ? `${formatTokens(sessionInput ?? 0)} / ${formatTokens(sessionOutput ?? 0)}`
                  : `${formatTokens(turnInput ?? 0)} / ${formatTokens(snap?.outputTokens ?? 0)}`}
              </Row>
            </div>

            {(cacheRead || cacheWrite || cacheHit !== undefined) && (
              <>
                <div className="my-1.5 h-px bg-line" />
                <div className="space-y-1 text-[11px]">
                  <div className="text-[10.5px] text-faint">{t("缓存（最近一次请求）", "Cache (last request)")}</div>
                  {cacheRead ? <Row label={t("缓存读取", "From cache")}>{formatTokens(cacheRead)}</Row> : null}
                  {cacheWrite ? <Row label={t("缓存写入", "Cache write")}>{formatTokens(cacheWrite)}</Row> : null}
                  {cacheHit !== undefined && (
                    <Row label={t("缓存命中", "Cache hit")}>{Math.round(cacheHit * 100)}%</Row>
                  )}
                </div>
              </>
            )}

            {tps !== undefined && (
              <>
                <div className="my-1.5 h-px bg-line" />
                <div className="text-[11px]">
                  <Row label={t("生成速度", "Throughput")}>{Math.round(tps)} tok/s</Row>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
