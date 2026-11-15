import { Collapsible } from "../common/Collapsible";
import type { ToolItem } from "../../lib/model";

/** 兜底卡片：任何未注册的工具都能显示，保证版本升级后不出现空白卡片。 */
export function GenericCard({ item }: { item: ToolItem }) {
  const running = item.result === undefined;
  const inputText = safePretty(item.input);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800">
        <span aria-hidden>🔧</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">{item.name}</span>
        <span className="ml-auto text-[11px] text-slate-400">
          {running ? "运行中…" : item.isError ? "失败" : "完成"}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        <Collapsible title="参数" summary={preview(inputText)}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{inputText}</pre>
        </Collapsible>
        {item.result !== undefined && (
          <Collapsible title="结果" summary={preview(item.result)}>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{item.result}</pre>
          </Collapsible>
        )}
      </div>
    </div>
  );
}

function safePretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

function preview(s: string): string {
  const first = s.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}
