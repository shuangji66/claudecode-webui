import { useState } from "react";
import { clockTime } from "../../lib/labels";
import { IconCopy } from "../common/Icons";

export function UserBubble({ text, ts }: { text: string; ts?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时静默失败 */
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] bg-bubble px-4 py-2.5 text-[14.5px] leading-[1.65] text-ink">
        {text}
      </div>
      <div className="flex items-center gap-1.5 pr-1 text-[10px] text-faint">
        {typeof ts === "number" && ts > 0 && <span>{clockTime(ts)}</span>}
        <button type="button" onClick={() => void copy()} className="rounded p-0.5 hover:text-ink" aria-label="复制消息">
          <IconCopy size={12} />
        </button>
        {copied && <span>已复制</span>}
      </div>
    </div>
  );
}
