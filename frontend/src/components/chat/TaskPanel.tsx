// 对话里的任务面板（对齐 DSH 的任务清单）：标题一行报数量（已完成 / 进行中 / 待完成），
// 默认收起，展开才是带状态的清单，贴在输入框上方。
//
// 数据全部来自消息流（`lib/tasks.ts`），组件不存任务状态：面板因此天然跟着对话走、
// 回放转录时也是同一份结果，不需要额外接口。
import { useMemo, useState } from "react";
import type { Item } from "../../lib/model";
import { taskCounts, taskEntries } from "../../lib/tasks";
import { useT } from "../../lib/i18n";
import { IconCheck, IconChevronRight } from "../common/Icons";

interface Props {
  items: Item[];
}

export function TaskPanel({ items }: Props) {
  const t = useT();
  const entries = useMemo(() => taskEntries(items), [items]);
  const counts = useMemo(() => taskCounts(entries), [entries]);
  // 默认收起（对齐 DSH）：面板常驻在输入框上方，一行数量足够回答「还剩多少」，
  // 想看细节再点开——展开着会一直挤占输入区。
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  // 顺序与 DSH 一致：已完成 → 进行中 → 待完成；数量为 0 的那档不出现。
  const parts: string[] = [];
  if (counts.completed > 0) parts.push(t(`${counts.completed} 已完成`, `${counts.completed} done`));
  if (counts.inProgress > 0) parts.push(t(`${counts.inProgress} 进行中`, `${counts.inProgress} in progress`));
  if (counts.pending > 0) parts.push(t(`${counts.pending} 待完成`, `${counts.pending} to do`));
  const summary = parts.join(" · ");

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-panel/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-muted hover:bg-panel-strong/60 hover:text-ink"
        aria-expanded={open}
      >
        <IconChevronRight size={13} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0 font-medium">{t("任务", "Tasks")}</span>
        <span className="min-w-0 truncate text-[10.5px] text-faint">{summary}</span>
      </button>
      {open && (
        <ul className="dsh-scroll max-h-60 space-y-1 overflow-y-auto border-t border-line px-3 py-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
              {e.status === "completed" ? (
                <IconCheck size={12} className="mt-[1px] shrink-0 text-ok" />
              ) : (
                <span
                  className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    e.status === "in_progress" ? "bg-brand" : "bg-line"
                  }`}
                  aria-hidden="true"
                />
              )}
              <span
                className={`min-w-0 flex-1 break-words ${
                  e.status === "completed"
                    ? "text-faint"
                    : e.status === "in_progress"
                      ? "text-ink"
                      : "text-muted"
                }`}
              >
                {e.status === "in_progress" && e.activeForm ? e.activeForm : e.subject}
              </span>
              {e.blockedBy.length > 0 && e.status !== "completed" && (
                <span className="shrink-0 text-[10.5px] text-faint">
                  {t(`等待 #${e.blockedBy.join(", #")}`, `waiting on #${e.blockedBy.join(", #")}`)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
