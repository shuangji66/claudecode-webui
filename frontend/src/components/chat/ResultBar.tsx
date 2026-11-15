import type { ResultItem } from "../../lib/model";

export function ResultBar({ item }: { item: ResultItem }) {
  const denials = item.denials ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
      {typeof item.durationMs === "number" && <span>{(item.durationMs / 1000).toFixed(1)}s</span>}
      {typeof item.costUsd === "number" && <span>${item.costUsd.toFixed(4)}</span>}
      {item.isError && <span className="text-rose-500">本轮出错</span>}
      {denials.length > 0 && (
        <span className="text-amber-600 dark:text-amber-400">{denials.length} 次工具调用被拒绝</span>
      )}
    </div>
  );
}
