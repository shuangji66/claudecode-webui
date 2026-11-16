import { Collapsible } from "../common/Collapsible";
import { IconTerminal } from "../common/Icons";
import type { ToolItem } from "../../lib/model";
import { ToolImages } from "./ToolImages";
import { useT } from "../../lib/i18n";

interface Props {
  item: ToolItem;
}

/** Bash 卡片：命令常显，输出默认收起（长输出会毁掉滚动）。 */
export function BashCard({ item }: Props) {
  const t = useT();
  const input = (item.input ?? {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  const desc = typeof input.description === "string" ? input.description : "";
  const running = item.result === undefined;

  return (
    <div className={`overflow-hidden rounded-xl border ${item.isError ? "border-rose-300 dark:border-rose-900" : "border-line"}`}>
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2 text-[12px]">
        <IconTerminal size={14} className="shrink-0 text-muted" />
        <span className="font-medium text-ink">Bash</span>
        {desc && <span className="truncate text-[11px] text-muted">{desc}</span>}
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${running ? "bg-brand-soft text-brand" : item.isError ? "bg-rose-50 text-danger dark:bg-rose-950/30" : "bg-panel-strong text-muted"}`}>
          {running
            ? typeof item.progress === "number"
              ? t(`运行中 ${item.progress}s`, `Running ${item.progress}s`)
              : t("运行中…", "Running…")
            : item.isError
              ? t("失败", "Failed")
              : t("完成", "Done")}
        </span>
      </div>
      <pre className="overflow-x-auto bg-[#0f1115] px-3 py-2.5 text-[12px] leading-relaxed text-[#d9e0e8]">
        <code>
          <span className="mr-1.5 select-none text-brand">$</span>
          {command}
        </code>
      </pre>
      {item.result !== undefined && item.result !== "" && (
        <div className="px-3 py-2.5">
          <Collapsible title={t("输出", "Output")} summary={t(`${item.result.split("\n").length} 行`, `${item.result.split("\n").length} lines`)}>
            <pre
              className={`max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${
                item.isError ? "text-danger" : "text-ink-2"
              }`}
            >
              {item.result}
            </pre>
          </Collapsible>
        </div>
      )}
      {item.images && item.images.length > 0 && (
        <div className="px-3 pb-2.5">
          <ToolImages item={item} />
        </div>
      )}
    </div>
  );
}
