import { Collapsible } from "../common/Collapsible";
import { IconWrench } from "../common/Icons";
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";

/** 兜底卡片：任何未注册的工具都能显示，保证版本升级后不出现空白卡片。 */
export function GenericCard({ item }: { item: ToolItem }) {
  const t = useT();
  const running = item.result === undefined;
  const inputText = safePretty(item.input);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2 text-[12px]">
        <IconWrench size={14} className="shrink-0 text-muted" />
        <span className="font-medium text-ink">{item.name}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${running ? "bg-brand-soft text-brand" : item.isError ? "bg-rose-50 text-danger dark:bg-rose-950/30" : "bg-panel-strong text-muted"}`}>
          {running ? t("运行中…", "Running…") : item.isError ? t("失败", "Failed") : t("完成", "Done")}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <Collapsible title={t("参数", "Input")} summary={preview(inputText)}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">{inputText}</pre>
        </Collapsible>
        {item.result !== undefined && (
          <Collapsible title={t("结果", "Result")} summary={preview(item.result)}>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">
              {item.result}
            </pre>
          </Collapsible>
        )}
        {item.images && item.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {item.images.map((img, i) => (
              <img
                key={`${i}-${img.mediaType}`}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={t("工具结果图片", "Tool result image")}
                className="max-h-80 w-auto rounded-lg border border-line"
              />
            ))}
          </div>
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
