// 复制按钮：用户气泡与回答气泡共用（复制正文 + 「已复制」回执）。
//
// 尺寸固定 28px：手机上 12px 的图标 + 0.5 padding 根本点不中，桌面端也不该
// 靠 hover 才出现（触屏没有 hover）。回执就地显示在按钮右侧，不做 toast。
import { useState } from "react";
import { IconCopy } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";

/** 统一的点击区域与颜色。 */
const BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-panel-strong hover:text-ink active:text-brand";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <>
      <button type="button" onClick={() => void copy()} aria-label={label} title={label} className={BUTTON}>
        <IconCopy size={14} />
      </button>
      {copied && <span className="text-brand">{t("已复制", "Copied")}</span>}
    </>
  );
}
