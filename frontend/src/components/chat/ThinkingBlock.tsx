import { Collapsible } from "../common/Collapsible";
import { useT } from "../../lib/i18n";

export function ThinkingBlock({ text }: { text: string }) {
  const t = useT();
  return (
    <Collapsible title={t("思考过程", "Reasoning")} summary={t(`${text.length} 字`, `${text.length} chars`)} tone="muted">
      <p className="whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-muted">{text}</p>
    </Collapsible>
  );
}
