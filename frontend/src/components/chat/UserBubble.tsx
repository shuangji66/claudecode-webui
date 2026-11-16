import { clockTime } from "../../lib/labels";
import { CopyButton } from "./CopyButton";
import { useLocale, useT } from "../../lib/i18n";

export function UserBubble({ text, ts }: { text: string; ts?: number }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="chat-text max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] bg-bubble px-4 py-2.5 text-ink">
        {text}
      </div>
      <div className="flex items-center gap-1.5 pr-1 text-[10.5px] text-faint">
        {typeof ts === "number" && ts > 0 && <span className="tabular-nums">{clockTime(ts, locale)}</span>}
        <CopyButton text={text} label={t("复制消息", "Copy message")} />
      </div>
    </div>
  );
}
