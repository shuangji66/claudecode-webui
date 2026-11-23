import { useState } from "react";
import { IconChevronDown, IconSpark, IconTerminal } from "../common/Icons";
import { clockTime } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import { wakeLabel, type WakeItem } from "../../lib/model";

/**
 * 「这一轮是被谁唤醒的」——后台任务结束时 CLI 注入的那条通知（`<task-notification>`）。
 *
 * 对齐 DSH 的 `TurnTriggerNodeView`：**一条带图标的圆角横条**，不是用户气泡，也不是
 * 过程行。三件事要说清楚：
 *
 *   ① **它不是用户说的话**。渲染成气泡，界面上就多出一条以 `<task-notification>` 开头
 *      的原始 XML（曾经就是这样）；缩成一行灰字又会被当成系统噪音划过。
 *   ② **它开了一轮**（`WakeItem` 的文件头有 CLI 的 `turnPosition` 证据）。所以它站在
 *      轮首，下面那一轮的收起行、思考、工具都归它——「已完成，用时 8 秒」说的是
 *      「子代理回报之后主任务跑了 8 秒」，而不是等待子代理的那十分钟。
 *   ③ **点开才看通知原文**（`max-h-60` 可滚）：`<result>` 那一坨可能有几万字，
 *      摆进正文流就把对话撑爆了；但排查「子代理到底报了什么叫主任务这么说」时，
 *      它就是唯一的原文。
 *
 * 时刻在右侧（与 DSH 一致）：这是时间线上的一根钉子，不是一句话的结尾。
 */
export function WakeRow({ item }: { item: WakeItem }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const label = wakeLabel(item, locale);
  // 后台命令 / MCP 调用没有对话可看，用终端图标；子代理用火花（与页头子智能体入口一致）。
  const Icon = item.summary?.includes("Agent") ? IconSpark : IconTerminal;

  return (
    <div className="rounded-xl border border-line bg-panel/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] text-muted transition hover:text-ink"
      >
        <Icon size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">{label}</span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-faint">{clockTime(item.ts, locale)}</span>
        <IconChevronDown
          size={12}
          className={`shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          <p className="mb-1 text-[10.5px] text-faint">
            {t("这条通知唤醒了本轮，下面是它的原文。", "This notification woke the turn; the original text is below.")}
          </p>
          <pre className="dsh-scroll max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[10.5px] leading-relaxed text-ink-2">
            {item.text}
          </pre>
        </div>
      )}
    </div>
  );
}
