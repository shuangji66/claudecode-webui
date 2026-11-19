import { Collapsible } from "../common/Collapsible";
import { IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";

/**
 * 思考块：一行摘要（思考首行）＋ 点开看全文，默认收起。
 *
 * **它自己不管收起时机**：整轮过程什么时候收进轮首那一行，是 `TurnCollapse` 的事。
 * 以前这里还有个 `live` 参数，回答一出现就把块重挂回收起态；改成轮级收起之后，
 * 那属于重复折叠，已经删掉。
 *
 * 摘要是**首行正文**，正文全是空白时才退回字数。`normalize` 已经把纯空白的 thinking
 * 挡在外面（上游会在工具调用之间发一个 `" "`），这里再兜一层：摘要退回字数时点开
 * 只会看到一个空格，那种行不该长得像「有内容」。
 */
export function ThinkingBlock({ text, dense = false }: { text: string; dense?: boolean }) {
  const t = useT();
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  const chars = t(`${text.trim().length} 字`, `${text.trim().length} chars`);
  const summary = firstLine || chars;

  return (
    <Collapsible
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
