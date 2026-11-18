import { Collapsible } from "../common/Collapsible";
import { IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";

/**
 * 思考块。
 *
 * `preview` 是「简洁」模式之外的那一行首行预览（对齐 DSH 的已结算推理预览）；
 * `live` 表示它还挂在正在进行的尾部——一旦回答/下一步出现（live 变 false），
 * 立刻折回一行：这就是需求里的「回答结束时自动折叠思维过程」。
 * 历史块（一直 live=false）不受影响，用户点开一个就保持打开。
 */
export function ThinkingBlock({
  text,
  dense = false,
  preview = true,
  live = false,
}: {
  text: string;
  dense?: boolean;
  preview?: boolean;
  live?: boolean;
}) {
  const t = useT();
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  const chars = t(`${text.length} 字`, `${text.length} chars`);
  const summary = preview && firstLine ? firstLine : chars;

  return (
    <Collapsible
      key={live ? "live" : "settled"}
      title={t("思考过程", "Reasoning")}
      summary={summary}
      tone="muted"
      dense={dense}
      icon={dense ? <IconSpark size={12} /> : undefined}
    >
      <p className="whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-muted">{text}</p>
    </Collapsible>
  );
}
