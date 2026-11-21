// 代码块上的复制按钮（Bash 命令 / 命令输出）。
//
// 与 `chat/CopyButton` 的差别只在长相与回执：那个给气泡用，浅底、按钮右侧补一句
// 「已复制」；这里的按钮贴在**深色命令块**上、或挤在折叠块的标题行里，一句话的
// 回执会把摘要挤走，所以回执改成图标换勾（`aria-label` 一起换，读屏也能听见）。
// 点击区域仍是 28px：手机上 14px 的图标没有更大的热区基本点不中。
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";

interface Props {
  text: string;
  /** 未复制时的可访问名（复制命令 / 复制输出）。 */
  label: string;
  /** `dark` 贴在深色命令块上；`plain` 用在浅底标题行里。 */
  tone?: "plain" | "dark";
}

export function CopyCodeButton({ text, label, tone = "plain" }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const skin =
    tone === "dark"
      ? "text-[#8b95a5] hover:bg-white/10 hover:text-white"
      : "text-faint hover:bg-panel-strong hover:text-ink";
  const title = copied ? t("已复制", "Copied") : label;

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={title}
      title={title}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${skin} ${
        copied ? "text-brand" : ""
      }`}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}
