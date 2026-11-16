import { useState } from "react";
import { Markdown } from "../common/Markdown";
import { IconCopy } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";

export function AssistantBubble({ text, streaming }: { text: string; streaming: boolean; ts?: number }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <div className="group relative">
      <div className="text-ink">
        <Markdown text={text} />
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-brand opacity-80" />}
      </div>
      {/* 复制**常驻可见**，不再只靠 group-hover：触屏没有 hover，手机上等于没有入口。
          这行始终占高度（h-4），出现与否不会让消息上下跳。 */}
      {!streaming && text.trim() && (
        <div className="mt-1 flex h-4 items-center gap-1 text-[10px] text-faint">
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t("复制回复", "Copy reply")}
            title={t("复制回复", "Copy reply")}
            className="-m-1 rounded p-1 hover:text-ink active:text-brand"
          >
            <IconCopy size={12} />
          </button>
          {copied && <span className="text-brand">{t("已复制", "Copied")}</span>}
        </div>
      )}
    </div>
  );
}
