import { useMemo, useRef, useState } from "react";
import type { CommandInfo } from "../../transport/types";

interface Props {
  disabled: boolean;
  commands: CommandInfo[];
  onSend: (text: string) => void;
  onInterrupt: () => void;
  busy: boolean;
}

/** 输入框：Enter 发送、Shift+Enter 换行；输入 "/" 时给出斜杠命令补全。 */
export function Composer({ disabled, commands, onSend, onInterrupt, busy }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ")) return [];
    const q = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [text, commands]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      {suggestions.length > 0 && (
        <div className="mb-2 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
          {suggestions.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                setText(`/${c.name} `);
                ref.current?.focus();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <span className="font-mono font-medium text-slate-700 dark:text-slate-200">/{c.name}</span>
              {c.argumentHint && <span className="ml-1 text-slate-400">{c.argumentHint}</span>}
              {c.description && <span className="ml-2 text-slate-400">{c.description.slice(0, 60)}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "会话未连接" : "输入消息，Enter 发送，Shift+Enter 换行，/ 唤起命令"}
          className="max-h-40 min-h-[42px] flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        {busy ? (
          <button
            type="button"
            onClick={onInterrupt}
            className="h-[42px] rounded-xl bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-700"
          >
            中断
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="h-[42px] rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
