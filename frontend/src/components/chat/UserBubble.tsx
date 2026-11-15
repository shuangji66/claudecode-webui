import { useState } from "react";
import { clockTime } from "../../lib/labels";
import { IconCopy } from "../common/Icons";
import { useLocale, useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";

export function UserBubble({ text, ts }: { text: string; ts?: number }) {
  const t = useT();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="chat-text max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] bg-bubble px-4 py-2.5 text-ink">
        {text}
      </div>
      <div className="flex items-center gap-1.5 pr-1 text-[10px] text-faint">
        {typeof ts === "number" && ts > 0 && <span>{clockTime(ts, locale)}</span>}
        <button type="button" onClick={() => void copy()} className="rounded p-0.5 hover:text-ink" aria-label={t("复制消息", "Copy message")}>
          <IconCopy size={12} />
        </button>
        {copied && <span>{t("已复制", "Copied")}</span>}
      </div>
    </div>
  );
}
