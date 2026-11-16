import { useMemo } from "react";
import { Collapsible } from "../common/Collapsible";
import { IconWrench } from "../common/Icons";
import { writeDiff } from "../../lib/diff";
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";
import { ToolImages } from "./ToolImages";

/**
 * Write 卡片：新建文件时输入是 file_path/content，没有 old_string/new_string。
 *
 * 之前它被注册成 EditCard，diff 构造必然失败，卡片只剩「无结构化补丁」+ 一行
 * "File created successfully" —— 写进去的内容在界面上完全看不到。
 */
export function WriteCard({ item }: { item: ToolItem }) {
  const t = useT();
  const diff = useMemo(() => writeDiff(item.input), [item.input]);
  const path =
    item.input && typeof item.input === "object" && typeof (item.input as Record<string, unknown>).file_path === "string"
      ? String((item.input as Record<string, unknown>).file_path)
      : t("新建文件", "New file");

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2 text-[12px]">
        <IconWrench size={14} className="shrink-0 text-muted" />
        <span className="font-medium text-ink">Write</span>
        <span className="truncate font-mono text-[11px] text-muted">
          {path}
          {diff ? `  +${diff.added}` : ""}
        </span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${
            item.isError
              ? "bg-rose-50 text-danger dark:bg-rose-950/30"
              : item.result === undefined
                ? "bg-brand-soft text-brand"
                : "bg-panel-strong text-muted"
          }`}
        >
          {item.isError ? t("失败", "Failed") : item.result === undefined ? t("进行中", "Working") : t("完成", "Done")}
        </span>
      </div>
      {diff ? (
        <div className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[1.6]">
          {diff.lines.map((l, i) => (
            <div key={i} className="flex bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
              <span className="w-6 shrink-0 select-none text-center opacity-60">+</span>
              <span className="whitespace-pre-wrap break-words pr-3">{l.text || " "}</span>
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
    </div>
  );
}
