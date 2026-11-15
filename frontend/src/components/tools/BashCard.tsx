import { Collapsible } from "../common/Collapsible";
import type { ToolItem } from "../../lib/model";

interface Props {
  item: ToolItem;
}

/** Bash 卡片：命令常显，输出默认收起（长输出会毁掉滚动）。 */
export function BashCard({ item }: Props) {
  const input = (item.input ?? {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  const desc = typeof input.description === "string" ? input.description : "";
  const running = item.result === undefined;

  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        item.isError ? "border-rose-300 dark:border-rose-800" : "border-slate-200 dark:border-slate-700"
      }`}
    >
      <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800">
        <span aria-hidden>▶_</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">Bash</span>
        {desc && <span className="truncate text-slate-400">{desc}</span>}
        <span className="ml-auto text-[11px] text-slate-400">{running ? "运行中…" : item.isError ? "失败" : "完成"}</span>
      </div>
      <pre className="overflow-x-auto bg-slate-900 px-3 py-2 text-xs text-emerald-300">
        <code>$ {command}</code>
      </pre>
      {item.result !== undefined && item.result !== "" && (
        <Collapsible title="输出" summary={`${item.result.split("\n").length} 行`}>
          <pre
            className={`max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs ${
              item.isError ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-300"
            }`}
          >
            {item.result}
          </pre>
        </Collapsible>
      )}
    </div>
  );
}
