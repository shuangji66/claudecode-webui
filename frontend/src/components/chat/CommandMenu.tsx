// 输入框的 `/` 指令补全菜单。
//
// 纯展示：候选、高亮、说明都由 Composer 给，键盘也由它在 textarea 上仲裁
// （焦点始终留在 textarea，Tab/Enter/↑↓ 才拦得住）。这里只负责画出来并把点击转回去。
//
// 列表**不截断**：它就是「这个会话里有哪些指令」的答案，与 `+ → 指令` 看到的是同一份。
// 因此必须有滚动跟随——`max-h-56` 装不下几十条指令，不跟随的话键盘能选到看不见的行。

import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";

export interface CommandRow {
  name: string;
  desc: string;
  argumentHint?: string;
}

interface Props {
  rows: CommandRow[];
  /** 高亮行的名字；空串 / 不在列表里时都是不亮。 */
  highlight: string;
  onHover: (name: string) => void;
  onPick: (name: string) => void;
}

/** 点行时不抢焦点：焦点一旦离开 textarea，键盘仲裁就断了。 */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

export function CommandMenu({ rows, highlight, onHover, onPick }: Props) {
  const t = useT();
  const activeRef = useRef<HTMLButtonElement | null>(null);
  // 与 `@` 菜单同一条规矩：高亮走到可视区外面就把它滚进来（已经在视野里则不动）。
  useEffect(() => {
    const el = activeRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest" });
  }, [highlight, rows]);

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-canvas shadow-soft">
      {/* `overflow-x-hidden` 不是多余的：只写 `overflow-y-auto` 时，按 CSS 规则另一轴会被
          算成 auto，于是长 argumentHint 一超宽整块列表就横着滚。这里只许纵向滚。 */}
      <ul
        className="max-h-56 overflow-y-auto overflow-x-hidden p-1"
        aria-label={t("指令候选", "Command candidates")}
      >
        {rows.map((row) => {
          const active = row.name === highlight;
          return (
            <li key={row.name}>
              <button
                type="button"
                onClick={() => onPick(row.name)}
                onMouseDown={keepFocus}
                onMouseEnter={() => onHover(row.name)}
                ref={active ? activeRef : undefined}
                aria-current={active ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] ${
                  active ? "bg-panel-strong" : ""
                }`}
              >
                {/* 指令名是主信息，永远完整；参数提示与说明吃剩余宽度，装不下就截断。 */}
                <span className="shrink-0 font-mono font-medium text-ink">/{row.name}</span>
                {row.argumentHint && (
                  <span className="min-w-0 shrink truncate text-faint">{row.argumentHint}</span>
                )}
                {row.desc && (
                  <span className="ml-auto min-w-0 flex-1 truncate text-right text-[11px] text-muted">
                    {row.desc}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2 border-t border-line px-2 py-1 text-[10px] text-faint">
        <span className="min-w-0 truncate">
          {t("↑↓ 选择 · Enter 填入 · Esc 关闭", "↑↓ select · Enter inserts · Esc closes")}
        </span>
      </div>
    </div>
  );
}
