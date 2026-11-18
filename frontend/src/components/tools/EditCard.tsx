import { useMemo } from "react";
import { Collapsible } from "../common/Collapsible";
import { IconWrench } from "../common/Icons";
import { buildDiff, editSummary } from "../../lib/diff";
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";
import { ToolImages } from "./ToolImages";
import { ToolShell } from "./ToolShell";

const tone: Record<string, string> = {
  add: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
  del: "bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300",
  ctx: "text-ink-2",
  hunk: "bg-panel-strong text-muted",
};

/** Edit 正文：有结构化补丁就渲染行级 diff，否则退回 old/new 对比。 */
export function EditBody({ item }: { item: ToolItem }) {
  const t = useT();
  const diff = useMemo(() => buildDiff(item.input, item.structured), [item.input, item.structured]);

  return (
    <>
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
          <Collapsible title={t("变更内容", "Changes")} summary={t("无结构化补丁", "No structured patch")}>
            <pre className="overflow-x-auto text-[11.5px]">{item.result ?? t("（等待结果）", "(waiting for result)")}</pre>
          </Collapsible>
        </div>
      )}
      {item.images && item.images.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <ToolImages item={item} />
        </div>
      )}
    </>
  );
}

export function EditCard({ item }: { item: ToolItem }) {
  const diff = useMemo(() => buildDiff(item.input, item.structured), [item.input, item.structured]);
  return (
    <ToolShell
      item={item}
      icon={<IconWrench size={14} />}
      title="Edit"
      subtitle={editSummary(item.input, diff)}
    >
      <EditBody item={item} />
    </ToolShell>
  );
}
