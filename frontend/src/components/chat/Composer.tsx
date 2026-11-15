import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandInfo } from "../../transport/types";
import { permissionLabel } from "../../lib/labels";
import { IconChevronDown, IconPlus, IconSend, IconShield, IconSpark, IconStop } from "../common/Icons";

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
}

interface Props {
  disabled: boolean;
  /** 连接断开时只禁用发送，保留输入框里的草稿与焦点。 */
  sendBlocked: boolean;
  starting: boolean;
  commands: CommandInfo[];
  busy: boolean;
  placeholder?: string;
  modelOptions: ModelOption[];
  selectedKey: string;
  permissionMode: string;
  onSelectModel: (provider: string, model: string) => void;
  onPermissionMode: (mode: string) => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  footer?: ReactNode;
}

const PERMISSION_MODES = ["", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

/** 输入卡：Enter 发送、Shift+Enter 换行；"/" 唤起命令补全。 */
export function Composer({
  disabled,
  sendBlocked,
  starting,
  commands,
  busy,
  placeholder,
  modelOptions,
  selectedKey,
  permissionMode,
  onSelectModel,
  onPermissionMode,
  onSend,
  onInterrupt,
  footer,
}: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

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
    const el = ref.current;
    if (el) el.style.height = "auto";
  };

  const hint = starting
    ? "正在启动 Claude…"
    : sendBlocked
      ? "连接断开，正在自动重连…"
      : disabled
        ? (placeholder ?? "连接未就绪")
        : "输入消息，/ 命令";

  return (
    <div className="w-full">
      {suggestions.length > 0 && (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-soft">
          {suggestions.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                setText(`/${c.name} `);
                ref.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-panel-strong"
            >
              <span className="font-mono font-medium text-ink">/{c.name}</span>
              {c.argumentHint && <span className="text-faint">{c.argumentHint}</span>}
              {c.description && <span className="ml-auto max-w-[55%] truncate text-[11px] text-muted">{c.description}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="composer-card px-3 pb-2.5 pt-2">
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
          placeholder={hint}
          aria-label="消息输入框"
          className="composer-textarea w-full bg-transparent px-1 text-[14px] leading-6 text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />

        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setText((t) => (t ? t : "/"));
              ref.current?.focus();
            }}
            disabled={disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-40"
            aria-label="斜杠命令"
            title="斜杠命令"
          >
            <IconPlus size={17} />
          </button>

          <label className="relative flex min-w-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted hover:bg-panel-strong" title="权限模式">
            <IconShield size={13} className="shrink-0" />
            <span className="max-w-[7rem] truncate">{permissionLabel(permissionMode)}</span>
            <IconChevronDown size={11} className="shrink-0 opacity-60" />
            <select
              value={permissionMode}
              onChange={(e) => onPermissionMode(e.target.value)}
              disabled={disabled}
              className="absolute inset-0 cursor-pointer appearance-none opacity-0"
              aria-label="权限模式"
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m || "default"} value={m}>
                  {permissionLabel(m)}
                </option>
              ))}
            </select>
          </label>

          <label className="relative flex min-w-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted hover:bg-panel-strong" title="模型">
            <IconSpark size={13} className="shrink-0" />
            <span className="max-w-[9rem] truncate">
              {modelOptions.find((o) => `${o.provider}/${o.model}` === selectedKey)?.model ?? "未添加模型"}
            </span>
            <IconChevronDown size={11} className="shrink-0 opacity-60" />
            <select
              value={selectedKey}
              onChange={(e) => {
                const opt = modelOptions.find((o) => `${o.provider}/${o.model}` === e.target.value);
                if (opt) onSelectModel(opt.provider, opt.model);
              }}
              disabled={disabled || modelOptions.length === 0}
              className="absolute inset-0 cursor-pointer appearance-none opacity-0"
              aria-label="模型"
            >
              {modelOptions.length === 0 && <option value="">未添加模型</option>}
              {modelOptions.length > 0 && !selectedKey && <option value="">未选择模型</option>}
              {modelOptions.map((o) => (
                <option key={`${o.provider}/${o.model}`} value={`${o.provider}/${o.model}`}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex items-center gap-1.5">
            {busy ? (
              <button
                type="button"
                onClick={onInterrupt}
                disabled={sendBlocked}
                className="send-button is-stop disabled:opacity-40"
                aria-label="中断本轮"
                title="中断"
              >
                <IconStop size={15} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || sendBlocked || !text.trim()}
                className="send-button"
                aria-label="发送"
                title="发送（Enter）"
              >
                <IconSend size={17} />
              </button>
            )}
          </div>
        </div>
      </div>

      {footer && <div className="mt-1.5 flex items-center justify-between gap-3 px-1 text-[10px] text-faint">{footer}</div>}
    </div>
  );
}
