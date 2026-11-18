import { Collapsible } from "../common/Collapsible";
import { IconTerminal } from "../common/Icons";
import type { ToolItem } from "../../lib/model";
import { ToolImages } from "./ToolImages";
import { ToolShell } from "./ToolShell";
import { useT } from "../../lib/i18n";

interface Props {
  item: ToolItem;
}

function fields(item: ToolItem): Record<string, unknown> {
  return (item.input ?? {}) as Record<string, unknown>;
}

/** Bash 正文：命令常显，输出默认收起（长输出会毁掉滚动）。 */
export function BashBody({ item }: Props) {
  const t = useT();
  const raw = fields(item).command;
  const command = typeof raw === "string" ? raw : "";

  return (
    <>
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
    </>
  );
}

export function BashCard({ item }: Props) {
  const desc = fields(item).description;
  return (
    <ToolShell
      item={item}
      icon={<IconTerminal size={14} />}
      title="Bash"
      subtitle={typeof desc === "string" ? desc : ""}
    >
      <BashBody item={item} />
    </ToolShell>
  );
}
