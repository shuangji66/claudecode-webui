import { useMemo } from "react";
import { Collapsible } from "../common/Collapsible";
import { IconWrench } from "../common/Icons";
import { buildDiff, editSummary } from "../../lib/diff";
import type { ToolItem } from "../../lib/model";

const tone: Record<string, string> = {
  add: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
  del: "bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300",
  ctx: "text-ink-2",
  hunk: "bg-panel-strong text-muted",
};

/** Edit 卡片：有结构化补丁就渲染行级 diff，否则退回 old/new 对比。 */
export function EditCard({ item }: { item: ToolItem }) {
  const diff = useMemo(() => buildDiff(item.input, item.structured), [item.input, item.structured]);
  const summary = editSummary(item.input, diff);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2 text-[12px]">
        <IconWrench size={14} className="shrink-0 text-muted" />
        <span className="font-medium text-ink">Edit</span>
        <span className="truncate font-mono text-[11px] text-muted">{summary}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${item.isError ? "bg-rose-50 text-danger dark:bg-rose-950/30" : "bg-panel-strong text-muted"}`}>
          {item.isError ? "失败" : item.result === undefined ? "进行中" : "完成"}
        </span>
      </div>
      {diff ? (
        <div className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[1.6]">
          {diff.lines.map((l, i) => (
            <div key={i} className={`flex ${tone[l.type]}`}>
              <span className="w-6 shrink-0 select-none text-center opacity-60">
                {l.type === "add" ? "+" : l.type === "del" ? "−" : l.type === "hunk" ? "" : " "}
              </span>
              <span className="whitespace-pre-wrap break-words pr-3">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2.5">
          <Collapsible title="变更内容" summary="无结构化补丁">
            <pre className="overflow-x-auto text-[11.5px]">{item.result ?? "（等待结果）"}</pre>
          </Collapsible>
        </div>
      )}
    </div>
  );
}
