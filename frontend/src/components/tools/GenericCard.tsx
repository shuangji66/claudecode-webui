import { Collapsible } from "../common/Collapsible";
import { IconWrench } from "../common/Icons";
import type { ToolItem } from "../../lib/model";
import { useT } from "../../lib/i18n";
import { ToolImages } from "./ToolImages";
import { ToolShell } from "./ToolShell";

/** 兜底卡片的正文：参数与结果各一个折叠块。任何未注册的工具都能显示。 */
export function GenericBody({ item }: { item: ToolItem }) {
  const t = useT();
  const inputText = safePretty(item.input);
  return (
    <div className="space-y-2 px-3 py-2.5">
      <Collapsible title={t("参数", "Input")} summary={preview(inputText)}>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11.5px] leading-relaxed text-ink-2">{inputText}</pre>
      </Collapsible>
      {item.result !== undefined && (
        <Collapsible title={t("结果", "Result")} summary={preview(item.result)}>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11.5px] leading-relaxed text-ink-2">
            {item.result}
          </pre>
        </Collapsible>
      )}
      <ToolImages item={item} />
    </div>
  );
}

/** 兜底卡片：保证版本升级后新工具不会渲染成空白。 */
export function GenericCard({ item }: { item: ToolItem }) {
  return (
    <ToolShell item={item} icon={<IconWrench size={14} />} title={item.name}>
      <GenericBody item={item} />
    </ToolShell>
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
