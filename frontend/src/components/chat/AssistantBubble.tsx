import { useState } from "react";
import { Markdown } from "../common/Markdown";
import { IconCopy } from "../common/Icons";
import { useT } from "../../lib/i18n";

export function AssistantBubble({ text, streaming }: { text: string; streaming: boolean; ts?: number }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 忽略 */
    }
  };
  return (
    <div className="group relative">
      <div className="text-ink">
        <Markdown text={text} />
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-brand opacity-80" />}
      </div>
      {!streaming && text.trim() && (
        <div className="mt-1 flex h-4 items-center gap-1 text-[10px] text-faint opacity-0 transition group-hover:opacity-100">
          <button type="button" onClick={() => void copy()} className="rounded p-0.5 hover:text-ink" aria-label={t("复制回复", "Copy reply")}>
            <IconCopy size={12} />
          </button>
          {copied && <span>{t("已复制", "Copied")}</span>}
        </div>
      )}
    </div>
  );
}
