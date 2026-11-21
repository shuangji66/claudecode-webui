import { useMemo } from "react";
import { Collapsible } from "../common/Collapsible";
import { IconWrench } from "../common/Icons";
import { writeDiff } from "../../lib/diff";
import type { ToolItem } from "../../lib/model";
import { toolLabel } from "../../lib/tools";
import { useT } from "../../lib/i18n";
import { ToolImages } from "./ToolImages";
import { ToolShell } from "./ToolShell";

/** Write 正文：新建/覆盖文件时的全部内容（没有 old_string，走不了 Edit 的 diff）。 */
export function WriteBody({ item }: { item: ToolItem }) {
  const t = useT();
  const diff = useMemo(() => writeDiff(item.input), [item.input]);

  return (
    <>
      {diff ? (
        <div className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[1.6]">
          {diff.lines.map((l, i) => (
            <div key={i} className="flex bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
              <span className="w-6 shrink-0 select-none text-center opacity-60">+</span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere] pr-3">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2.5">
          <Collapsible title={t("变更内容", "Changes")} summary={t("没有读到写入内容", "No content")}>
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

export function WriteCard({ item }: { item: ToolItem }) {
  const t = useT();
  const diff = useMemo(() => writeDiff(item.input), [item.input]);
  const path =
    item.input && typeof item.input === "object" && typeof (item.input as Record<string, unknown>).file_path === "string"
      ? String((item.input as Record<string, unknown>).file_path)
      : t("新建文件", "New file");

  return (
    <ToolShell
      item={item}
      icon={<IconWrench size={14} />}
      title={toolLabel(item.name, t)}
      subtitle={`${path}${diff ? `  +${diff.added}` : ""}`}
    >
      <WriteBody item={item} />
    </ToolShell>
  );
}
