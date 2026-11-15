import type { ResultItem } from "../../lib/model";

export function ResultBar({ item }: { item: ResultItem }) {
  const denials = item.denials ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted">
      {typeof item.durationMs === "number" && (
        <span className="rounded-full bg-panel-strong px-2 py-0.5">{(item.durationMs / 1000).toFixed(1)}s</span>
      )}
      {typeof item.costUsd === "number" && <span className="rounded-full bg-panel-strong px-2 py-0.5">${item.costUsd.toFixed(4)}</span>}
      {item.isError && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-danger dark:bg-rose-950/40">本轮出错</span>}
      {denials.length > 0 && (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-warn dark:bg-amber-950/30">{denials.length} 次工具调用被拒绝</span>
      )}
    </div>
  );
}
