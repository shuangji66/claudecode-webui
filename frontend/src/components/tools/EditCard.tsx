import { useMemo } from "react";
import { Collapsible } from "../common/Collapsible";
import { buildDiff, editSummary } from "../../lib/diff";
import type { ToolItem } from "../../lib/model";

const tone: Record<string, string> = {
  add: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  del: "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
  ctx: "text-slate-600 dark:text-slate-400",
  hunk: "bg-slate-100 text-slate-500 dark:bg-slate-800",
};

/** Edit 卡片：有结构化补丁就渲染行级 diff，否则退回 old/new 对比。 */
export function EditCard({ item }: { item: ToolItem }) {
  const diff = useMemo(() => buildDiff(item.input, item.structured), [item.input, item.structured]);
  const summary = editSummary(item.input, diff);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800">
        <span aria-hidden>✎</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">Edit</span>
        <span className="truncate text-slate-400">{summary}</span>
      </div>
      {diff ? (
        <div className="max-h-80 overflow-auto font-mono text-xs">
          {diff.lines.map((l, i) => (
            <div key={i} className={`flex ${tone[l.type]}`}>
              <span className="w-5 shrink-0 select-none text-center opacity-60">
                {l.type === "add" ? "+" : l.type === "del" ? "−" : l.type === "hunk" ? "" : " "}
              </span>
              <span className="whitespace-pre-wrap break-words">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ) : (
        <Collapsible title="变更内容" summary="无结构化补丁">
          <pre className="overflow-x-auto text-xs">{item.result ?? "（等待结果）"}</pre>
        </Collapsible>
      )}
    </div>
  );
}
