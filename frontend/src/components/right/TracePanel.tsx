import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import {
  formatSpanMs,
  layoutLane,
  spanGeometry,
  traceTurns,
  type TraceLabelKey,
  type TraceLane,
  type TraceSpan,
  type TraceTurn,
} from "../../lib/trace";
import type { Item } from "../../lib/model";
import { useAppStore } from "../../store/useAppStore";
import { IconChevronRight } from "../common/Icons";

/**
 * 轨迹面板（右侧栏的一个标签，对齐 DSH 的「轨迹」）。
 *
 * 它不产生任何新数据：全部从 `items[sid]` 派生（`lib/trace.traceTurns`）。实时帧与转录
 * 回放走的是同一套 Item，所以「正在跑的这一轮」与「重开对话后的历史」画法一致，
 * 差别只在时间的来源（帧到达时刻 / 转录时间戳）。
 *
 * 三条泳道严格按 CLI 真给的边界画：模型请求 = 上一次活动结束 → 这一条消息落盘；
 * 工具 = tool_use → tool_result。段与段之间的空隙**留空**，它表示「这段时间没有任何
 * 已记录的步骤」，不画成任何实体。
 */
const LANES: { key: TraceLane; zh: string; en: string }[] = [
  { key: "model", zh: "模型", en: "Model" },
  { key: "tool", zh: "工具", en: "Tools" },
  { key: "subagent", zh: "子代理", en: "Subagents" },
  { key: "event", zh: "事件", en: "Events" },
];

const EMPTY: Item[] = [];

/**
 * 固定文案：`lib/trace` 只给键，文字在这里按界面语言出。
 *
 * 轨迹面板直接渲染这些文案，所以不能在 trace.ts 里写死中文（英文界面会混进中文）。
 */
const LABELS: Record<TraceLabelKey, { zh: string; en: string }> = {
  model: { zh: "模型请求", en: "Model request" },
  system: { zh: "系统事件", en: "System event" },
  error: { zh: "错误", en: "Error" },
  interruptUser: { zh: "用户中断", en: "Interrupted by user" },
  interruptAgent: { zh: "子代理中断", en: "Subagent interrupted" },
  interruptSession: { zh: "会话中断", en: "Session interrupted" },
  event: { zh: "事件", en: "Event" },
};

/** 工具分类 → 条形颜色：读/搜是绿、写/改是黄、命令是强调色，其余用中性色。 */
function barTone(span: TraceSpan): string {
  if (span.error) return "bg-danger";
  if (span.lane === "model") return span.running ? "bg-brand/35 ring-1 ring-inset ring-brand/70" : "bg-brand/70";
  if (span.lane === "subagent") return span.running ? "bg-brand/45 ring-1 ring-inset ring-brand/70" : "bg-brand";
  if (span.lane === "event") return "bg-faint";
  switch (span.category) {
    case "read":
      return "bg-ok/80";
    case "search":
      return "bg-ok/55";
    case "write":
      return "bg-warn/85";
    case "edit":
      return "bg-warn/65";
    case "commands":
      return "bg-brand/60";
    case "webSearch":
    case "webFetch":
      return "bg-brand/40";
    case "subagents":
      return "bg-brand";
    default:
      return "bg-muted/70";
  }
}

/** 总览条的颜色：按这一轮耗时最多的那类步骤上色，一眼看出这一轮在干什么。 */
function turnTone(turn: TraceTurn): string {
  const sum: Record<string, number> = { model: 0, tool: 0, subagent: 0 };
  for (const span of turn.spans) {
    if (span.lane === "model" || span.lane === "tool" || span.lane === "subagent") {
      sum[span.lane] += Math.max(0, span.end - span.start);
    }
  }
  if (sum.subagent > 0 && sum.subagent >= sum.tool) return "bg-brand";
  if (sum.tool > 0 && sum.tool > sum.model) return "bg-ok/80";
  return "bg-brand/45";
}

/** 只在有未结束的轮次时每秒跳一次：正在跑的工具/请求的条要跟着长。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** 一段步骤的主文案：数据自带的名字优先，固定文案按界面语言给。 */
function spanText(span: TraceSpan, t: (zh: string, en?: string) => string): string {
  if (span.label) return span.label;
  const label = span.labelKey ? LABELS[span.labelKey] : undefined;
  return label ? t(label.zh, label.en) : "";
}

function spanTitle(span: TraceSpan, lane: string, t: (zh: string, en?: string) => string): string {
  const dur = span.end > span.start ? formatSpanMs(span.end - span.start) : "";
  return [lane, spanText(span, t), span.detail, dur].filter(Boolean).join(" · ");
}

export function TracePanel({ active = true, onJump }: { active?: boolean; onJump?: () => void }) {
  const t = useT();
  const sid = useAppStore((s) => s.activeId);
  // **看不见时不要跟着每一条流式帧重算**：标签只是 hidden 不卸载（终端里挂着 PTY），
  // 而 `items[sid]` 每个 token 帧都是新数组——`traceTurns` 会把整轮重新切一遍。
  // 选择器返回同一个 EMPTY 引用时 zustand 不会触发重渲染，这样才真的省下来。
  const items = useAppStore((s) => (active && sid ? s.items[sid] ?? EMPTY : EMPTY));
  const running = useAppStore((s) => {
    if (!active) return false;
    const st = s.states[sid ?? ""];
    return st === "busy" || st === "starting";
  });
  const requestScrollToItem = useAppStore((s) => s.requestScrollToItem);
  const showSubagent = useAppStore((s) => s.showSubagent);

  const now = useNow(active && running);
  const turns = useMemo(() => traceTurns(items, running, now), [items, running, now]);
  /** null = 跟着最后一轮走；点过总览条之后就固定在看那一轮。 */
  const [selected, setSelected] = useState<number | null>(null);
  const index = Math.min(selected ?? turns.length - 1, Math.max(0, turns.length - 1));
  const turn = turns.length > 0 ? turns[index] : undefined;

  if (!sid) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted">
        {t("先打开一条对话，这里会显示它的轨迹。", "Open a conversation first; its trace shows up here.")}
      </div>
    );
  }

  if (!turn) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted">
        {t("这条对话还没有可画的步骤。", "Nothing to plot in this conversation yet.")}
      </div>
    );
  }

  /**
   * 点一步就跳到对话里的那一条。
   *
   * `onJump` 只负责「让挡住对话区的侧栏让开」（移动端抽屉 / 桌面全屏），停靠模式下
   * 调用方不会真的关。**没有 `itemId` 的段也要通知**：那几段（还在跑的请求、纯系统
   * 事件）点了本来就不会滚，但用户的手势仍然是想回对话区，此时什么都不做读起来
   * 就是「点空了」。
   */
  const jump = (span: TraceSpan) => {
    if (span.itemId) requestScrollToItem(span.itemId);
    onJump?.();
  };

  const totalMs = Math.max(1, turn.end - turn.start);
  const laneRows = LANES.map((lane) => ({ lane, spans: turn.spans.filter((s) => s.lane === lane.key) })).filter(
    (row) => row.spans.length > 0,
  );

  return (
    <div className="flex h-full flex-col">
      {/* 轮次总览：一条会话的全部轮次按耗时占比排开，点一下切到那一轮。 */}
      <div className="shrink-0 border-b border-line px-3 pb-2.5 pt-2">
        {/* 不再重复写一遍「轨迹」：标签条上已经有了。这里只留轮数，把纵向空间让给图。 */}
        <div className="flex items-center justify-end gap-2">
          <span className="text-[10.5px] text-faint">{t(`共 ${turns.length} 轮`, `${turns.length} turns`)}</span>
        </div>
        <div className="mt-2 flex h-5 items-stretch gap-[2px]" role="tablist" aria-label={t("轮次", "Turns")}>
          {turns.map((tn) => {
            const on = tn.index === index;
            const dur = Math.max(1, tn.end - tn.start);
            return (
              <button
                key={tn.index}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setSelected(tn.index)}
                title={t(`第 ${tn.index + 1} 轮 · ${formatSpanMs(dur)}`, `Turn ${tn.index + 1} · ${formatSpanMs(dur)}`)}
                style={{ flexGrow: dur, minWidth: 3 }}
                className={`rounded-sm ${turnTone(tn)} ${on ? "opacity-100 ring-1 ring-ink/40" : "opacity-55 hover:opacity-85"}`}
              />
            );
          })}
        </div>
      </div>

      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {/* 这一轮的抬头：谁问的、花了多久、用了什么。 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSelected(Math.max(0, index - 1))}
            disabled={index <= 0}
            aria-label={t("上一轮", "Previous turn")}
            className="rounded p-0.5 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-30"
          >
            <IconChevronRight size={13} className="rotate-180" />
          </button>
          <span className="text-[11px] tabular-nums text-muted">
            {t(`第 ${index + 1} 轮`, `Turn ${index + 1}`)} / {turns.length}
          </span>
          <button
            type="button"
            onClick={() => setSelected(Math.min(turns.length - 1, index + 1))}
            disabled={index >= turns.length - 1}
            aria-label={t("下一轮", "Next turn")}
            className="rounded p-0.5 text-muted hover:bg-black/5 hover:text-ink disabled:opacity-30"
          >
            <IconChevronRight size={13} />
          </button>
        </div>
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-ink">
          {turn.prompt || t("（这一轮没有用户输入）", "(no user input in this turn)")}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted">
          {turn.model && <span className="max-w-[10rem] truncate" title={turn.model}>{turn.model}</span>}
          <span className="tabular-nums">{formatSpanMs(turn.durationMs ?? totalMs)}</span>
          <span className="tabular-nums">{t(`${turn.toolCount} 次工具`, `${turn.toolCount} tools`)}</span>
          {turn.subagentCount > 0 && (
            <span className="tabular-nums">{t(`${turn.subagentCount} 个子代理`, `${turn.subagentCount} subagents`)}</span>
          )}
          {turn.inputTokens ? (
            <span className="tabular-nums">
              {t(`入 ${turn.inputTokens}`, `in ${turn.inputTokens}`)} ·{" "}
              {t(`出 ${turn.outputTokens ?? 0}`, `out ${turn.outputTokens ?? 0}`)}
            </span>
          ) : null}
          {!turn.finished && <span className="text-brand">{t("进行中", "running")}</span>}
        </div>

        {/* 泳道图：横轴 = 这一轮的墙钟时间，段与段之间的空隙就是「没有记录的步骤」。 */}
        <div className="mt-3 space-y-1.5">
          {laneRows.map(({ lane, spans }) => (
            <div key={lane.key} className="flex gap-1.5">
              <span className="w-8 shrink-0 pt-[2px] text-[10px] leading-tight text-faint">
                {t(lane.zh, lane.en)}
              </span>
              <div className="min-w-0 flex-1 space-y-[3px]">
                {layoutLane(spans).map((row, rowIndex) => (
                  <div key={rowIndex} className="flex items-center gap-1">
                    {/* 不画整条轨道：段与段之间的空隙就是「没有记录的步骤」，铺一层底色
                        会把这些空隙变成「已经在跑的东西」，看图的人会以为那一整段都有事发生。 */}
                    <div className="relative h-2.5 min-w-0 flex-1">
                      {row.map((span) => {
                        const { left, width } = spanGeometry(span, turn);
                        // 零时长的标记（压缩、报错、中断）给一颗小点，否则 3px 的横线在
                        // 白底上几乎看不见。
                        const point = span.end <= span.start;
                        return (
                          <button
                            key={span.id}
                            type="button"
                            onClick={() => jump(span)}
                            title={spanTitle(span, t(lane.zh, lane.en), t)}
                            aria-label={spanTitle(span, t(lane.zh, lane.en), t)}
                            style={{
                              left: `${left * 100}%`,
                              width: point ? 6 : `${Math.max(width * 100, 0.4)}%`,
                              minWidth: point ? 6 : 3,
                            }}
                            className={`absolute rounded-full ${barTone(span)} ${
                              point ? "top-[2px] h-1.5" : "top-0 h-full"
                            }`}
                          />
                        );
                      })}
                    </div>
                    {row
                      .filter((span) => span.agentId)
                      .map((span) => (
                        <button
                          key={`chat-${span.id}`}
                          type="button"
                          onClick={() => showSubagent(span.agentId!, spanText(span, t) || span.id)}
                          className="shrink-0 rounded px-1 text-[9.5px] text-muted hover:bg-black/5 hover:text-ink"
                          title={t("查看这个子代理的对话", "Open this subagent's conversation")}
                        >
                          {t("对话", "Chat")}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="ml-10 mt-1 flex justify-between text-[9.5px] tabular-nums text-faint">
          <span>0</span>
          <span>{formatSpanMs(totalMs)}</span>
        </div>

        {/* 步骤表：与上面同一批段，按时间排序，点一行跳到对话里的那一条。 */}
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 flex items-center justify-between text-[10.5px] text-faint">
            <span>{t("步骤", "Steps")}</span>
            <span>{t(`${turn.spans.length} 步`, `${turn.spans.length} steps`)}</span>
          </div>
          <div className="space-y-0.5">
            {turn.spans.map((span) => {
              const lane = LANES.find((l) => l.key === span.lane);
              const offset = Math.max(0, span.start - turn.start);
              const dur = span.end - span.start;
              return (
                <button
                  key={span.id}
                  type="button"
                  onClick={() => jump(span)}
                  className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-panel-strong"
                >
                  <span className="w-11 shrink-0 pt-[1px] text-[9.5px] tabular-nums text-faint">
                    +{formatSpanMs(offset)}
                  </span>
                  <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${barTone(span)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-ink">
                      {spanText(span, t) || (lane ? t(lane.zh, lane.en) : "")}
                      {span.running && <span className="ml-1 text-[9.5px] text-brand">{t("进行中", "running")}</span>}
                    </span>
                    {span.detail && <span className="block truncate text-[10px] text-muted">{span.detail}</span>}
                  </span>
                  <span className="shrink-0 pt-[1px] text-[9.5px] tabular-nums text-muted">
                    {dur > 0 ? formatSpanMs(dur) : "—"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
