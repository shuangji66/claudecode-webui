import type { ResultItem } from "../../lib/model";
import { useT } from "../../lib/i18n";

/** CLI 的 result 子类型 → 人话。未收录的原样显示 subtype。 */
const errorSubtypes: Record<string, [string, string]> = {
  error_max_turns: ["达到最大轮数上限", "Max turns reached"],
  error_during_execution: ["执行中出错", "Error during execution"],
  error_max_budget_usd: ["超出预算上限", "Budget limit reached"],
};

export function ResultBar({ item }: { item: ResultItem }) {
  const t = useT();
  const denials = item.denials ?? [];
  const known = item.subtype ? errorSubtypes[item.subtype] : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted">
        {typeof item.durationMs === "number" && (
          <span className="rounded-full bg-panel-strong px-2 py-0.5">{(item.durationMs / 1000).toFixed(1)}s</span>
        )}
        {item.isError && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-danger dark:bg-rose-950/40">{t("本轮出错", "Turn failed")}</span>
        )}
        {item.isError && known && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-danger dark:bg-rose-950/40">{t(known[0], known[1])}</span>
        )}
        {item.isError && !known && item.subtype && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 font-mono text-danger dark:bg-rose-950/40">{item.subtype}</span>
        )}
        {denials.length > 0 && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-warn dark:bg-amber-950/30">{t(`${denials.length} 次工具调用被拒绝`, `${denials.length} tool calls denied`)}</span>
        )}
      </div>
      {/* 失败原因：CLI 把它放在 result.result 里，不显示的话用户只看到「本轮出错」。 */}
      {item.text && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
          {item.text}
        </pre>
      )}
    </div>
  );
}
