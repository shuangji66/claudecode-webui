import type { ResultItem } from "../../lib/model";
import { useT } from "../../lib/i18n";

/** CLI 的 result 子类型 → 人话。未收录的原样显示 subtype。 */
const errorSubtypes: Record<string, [string, string]> = {
  error_max_turns: ["达到最大轮数上限", "Max turns reached"],
  error_during_execution: ["执行中出错", "Error during execution"],
  error_max_budget_usd: ["超出预算上限", "Budget limit reached"],
  error_max_structured_output_retries: ["结构化输出重试次数用尽", "Structured output retries exhausted"],
};

/**
 * 一轮结束时的提示条。
 *
 * **成功回合什么都不显示**：耗时/token/tok/s 已经写在最后一条回答下面的那一行
 * （`AssistantBubble` 的用量行），再挂一个「9.0s」胶囊只是重复。这里只在真的有事要说
 * 时渲染：本轮出错（含 CLI 给的 subtype 与原文）、有工具调用被拒绝。
 */
export function ResultBar({ item }: { item: ResultItem }) {
  const t = useT();
  const denials = item.denials ?? [];
  const known = item.subtype ? errorSubtypes[item.subtype] : undefined;
  // 模型拒答（refusal）时 CLI 给的是 subtype=success + is_error=true：把 "success"
  // 当作失败原因展示出来等于自相矛盾，原因正文已经在下面那一段里了。
  const unknown = item.subtype && item.subtype !== "success" ? item.subtype : undefined;
  if (!item.isError && denials.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted">
        {item.isError && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-danger dark:bg-rose-950/40">{t("本轮出错", "Turn failed")}</span>
        )}
        {item.isError && known && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-danger dark:bg-rose-950/40">{t(known[0], known[1])}</span>
        )}
        {item.isError && !known && unknown && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 font-mono text-danger dark:bg-rose-950/40">{unknown}</span>
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
