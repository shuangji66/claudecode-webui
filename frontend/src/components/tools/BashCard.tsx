import { Collapsible } from "../common/Collapsible";
import { IconTerminal } from "../common/Icons";
import type { ToolItem } from "../../lib/model";
import { toolLabel } from "../../lib/tools";
import { useT } from "../../lib/i18n";
import { CopyCodeButton } from "./CopyCodeButton";
import { ToolImages } from "./ToolImages";
import { ToolShell } from "./ToolShell";

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
  const lines = item.result === undefined ? 0 : item.result.split("\n").length;

  return (
    <>
      {/* `relative` + 右上角绝对定位的复制按钮：命令经常要拿去改一改再跑，
          手机上长按选中一条多行命令基本没法操作。`pr-11` 是给按钮让出的位置，
          否则长命令的第一行会钻到按钮下面。 */}
      <div className="relative">
        <pre className="overflow-x-auto bg-[#0f1115] py-2.5 pl-3 pr-11 text-[12px] leading-relaxed text-[#d9e0e8]">
          <code>
            <span className="mr-1.5 select-none text-brand">$</span>
            {command}
          </code>
        </pre>
        {command !== "" && (
          <div className="absolute right-1 top-1">
            <CopyCodeButton tone="dark" text={command} label={t("复制命令", "Copy command")} />
          </div>
        )}
      </div>
      {item.result !== undefined && item.result !== "" && (
        <div className="px-3 py-2.5">
          <Collapsible
            title={t("输出", "Output")}
            summary={t(`${lines} 行`, `${lines} lines`)}
            actions={<CopyCodeButton text={item.result} label={t("复制输出", "Copy output")} />}
          >
            <pre
              className={`max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11.5px] leading-relaxed ${
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
  const t = useT();
  const desc = fields(item).description;
  return (
    <ToolShell
      item={item}
      icon={<IconTerminal size={14} />}
      title={toolLabel(item.name, t)}
      subtitle={typeof desc === "string" ? desc : ""}
    >
      <BashBody item={item} />
    </ToolShell>
  );
}
