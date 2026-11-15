import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandInfo, WireAttachment } from "../../transport/types";
import { permissionLabel } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import type { ModelOption } from "../../lib/providerForm";
import {
  ATTACHMENT_ACCEPT,
  MAX_TOTAL_BYTES,
  formatBytes,
  readAttachment,
  toWireAttachment,
  type PendingAttachment,
} from "../../lib/attachments";
import { IconChevronDown, IconClose, IconFile, IconGauge, IconImage, IconPlus, IconSend, IconShield, IconSpark, IconStop } from "../common/Icons";

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
  selectedEffort: string;
  permissionMode: string;
  onSelectModel: (provider: string, model: string) => void;
  onSelectEffort: (effort: string) => void;
  onPermissionMode: (mode: string) => void;
  onSend: (text: string, attachments: WireAttachment[]) => void;
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
  selectedEffort,
  permissionMode,
  onSelectModel,
  onSelectEffort,
  onPermissionMode,
  onSend,
  onInterrupt,
  footer,
}: Props) {
  const t = useT();
  const locale = useLocale();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const selectedModel = modelOptions.find((o) => `${o.provider}/${o.model}` === selectedKey);
  const efforts = selectedModel?.spec.reasoning_efforts ?? [];

  const submit = () => {
    const value = text.trim();
    if ((!value && files.length === 0) || disabled) return;
    onSend(value, files.map(toWireAttachment));
    setText("");
    setFiles([]);
    setFileError(null);
    const el = ref.current;
    if (el) el.style.height = "auto";
  };

  const pickFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFileError(null);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    const next = [...files];
    for (const file of Array.from(list)) {
      try {
        const attachment = await readAttachment(file, locale);
        if (total + attachment.size > MAX_TOTAL_BYTES) {
          setFileError(t("附件总大小不能超过 10MB", "Attachments cannot exceed 10MB in total"));
          break;
        }
        next.push(attachment);
        total += attachment.size;
      } catch (e) {
        setFileError(e instanceof Error ? e.message : String(e));
      }
    }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = "";
  };

  const hint = starting
    ? t("正在启动 Claude…", "Starting Claude…")
    : sendBlocked
      ? t("连接断开，正在自动重连…", "Disconnected, reconnecting…")
      : disabled
        ? (placeholder ?? t("连接未就绪", "Connection not ready"))
        : t("输入消息，/ 命令", "Message, / commands");

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
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <div key={f.id} className="flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-panel/60 px-1.5 py-1">
                {f.kind === "image" ? (
                  <img
                    src={`data:${f.mediaType};base64,${f.data}`}
                    alt=""
                    className="h-7 w-7 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-canvas text-muted">
                    <IconFile size={15} />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block max-w-[10rem] truncate text-[10.5px] text-ink">{f.name}</span>
                  <span className="block text-[9px] text-faint">{formatBytes(f.size)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setFiles((prev) => prev.filter((x) => x.id !== f.id));
                    setFileError(null);
                  }}
                  className="rounded p-0.5 text-faint hover:text-danger"
                  aria-label={t(`移除 ${f.name}`, `Remove ${f.name}`)}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {fileError && <p className="mb-1.5 text-[10.5px] text-danger">{fileError}</p>}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept={ATTACHMENT_ACCEPT}
          disabled={disabled}
          onChange={(e) => void pickFiles(e.target.files)}
        />
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
          aria-label={t("消息输入框", "Message input")}
          className="composer-textarea chat-text w-full bg-transparent px-1 leading-6 text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />

        <div className="mt-1.5 flex items-center gap-1 sm:gap-1.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-40"
            aria-label={t("添加文件或图片", "Add file or image")}
            title={t("添加文件或图片", "Add file or image")}
          >
            <IconPlus size={17} />
          </button>

          <label className="relative flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted hover:bg-panel-strong" title={t("权限模式", "Permission mode")}>
            <IconShield size={13} className="shrink-0" />
            <span className="hidden max-w-[7rem] truncate sm:inline">{permissionLabel(permissionMode, locale)}</span>
            <IconChevronDown size={11} className="shrink-0 opacity-60" />
            <select
              value={permissionMode}
              onChange={(e) => onPermissionMode(e.target.value)}
              disabled={disabled}
              className="absolute inset-0 cursor-pointer appearance-none opacity-0"
              aria-label={t("权限模式", "Permission mode")}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m || "default"} value={m}>
                  {permissionLabel(m, locale)}
                </option>
              ))}
            </select>
          </label>

          <label className="relative flex min-w-0 flex-1 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted hover:bg-panel-strong" title={t("模型", "Model")}>
            <IconSpark size={13} className="shrink-0" />
            <span className="min-w-0 truncate">{selectedModel ? (selectedModel.spec.name || selectedModel.model) : t("未添加模型", "No models")}</span>
            {selectedModel?.spec.supports_image && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-brand-soft px-1 text-[9px] text-brand" title={t("支持图片输入", "Supports image input")}>
                <IconImage size={10} />
                <span className="hidden sm:inline">{t("图片", "Image")}</span>
              </span>
            )}
            <IconChevronDown size={11} className="shrink-0 opacity-60" />
            <select
              value={selectedKey}
              onChange={(e) => {
                const opt = modelOptions.find((o) => `${o.provider}/${o.model}` === e.target.value);
                if (opt) onSelectModel(opt.provider, opt.model);
              }}
              disabled={disabled || modelOptions.length === 0}
              className="absolute inset-0 cursor-pointer appearance-none opacity-0"
              aria-label={t("模型", "Model")}
            >
              {modelOptions.length === 0 && <option value="">{t("未添加模型", "No models")}</option>}
              {modelOptions.length > 0 && !selectedKey && <option value="">{t("未选择模型", "No model selected")}</option>}
              {modelOptions.map((o) => (
                <option key={`${o.provider}/${o.model}`} value={`${o.provider}/${o.model}`}>
                  {o.label}
                  {o.spec.supports_image ? t(" · 图片", " · Image") : ""}
                </option>
              ))}
            </select>
          </label>

          {efforts.length > 0 && (
            <label
              className="relative flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted hover:bg-panel-strong"
              title={t("推理强度（在新建会话时生效）", "Reasoning effort (applies to new sessions)")}
            >
              <IconGauge size={13} className="shrink-0" />
              <span className="max-w-[5rem] truncate">{selectedEffort || t("默认", "Default")}</span>
              <IconChevronDown size={11} className="shrink-0 opacity-60" />
              <select
                value={selectedEffort}
                onChange={(e) => onSelectEffort(e.target.value)}
                disabled={disabled}
                className="absolute inset-0 cursor-pointer appearance-none opacity-0"
                aria-label={t("推理强度", "Reasoning effort")}
              >
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {busy ? (
              <button
                type="button"
                onClick={onInterrupt}
                disabled={sendBlocked}
                className="send-button is-stop disabled:opacity-40"
                aria-label={t("中断本轮", "Stop this turn")}
                title={t("中断", "Stop")}
              >
                <IconStop size={15} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || sendBlocked || (!text.trim() && files.length === 0)}
                className="send-button"
                aria-label={t("发送", "Send")}
                title={t("发送（Enter）", "Send (Enter)")}
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
