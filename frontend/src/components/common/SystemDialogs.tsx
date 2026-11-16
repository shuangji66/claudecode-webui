// 全局确认 / 输入对话框：替代 window.confirm / window.prompt。
//
// 原生弹窗在飞牛桌面 iframe 里会被宿主样式接管（按钮文案、深浅色、字号都不可控），
// 而这里复用同一套 Dialog/Button，和界面其它模态完全一致。
//
// 用法（命令式，调用点最少）：
//     if (!(await askConfirm({ title: "删除对话？", message: "…", danger: true }))) return;
//     const name = await askPrompt({ title: "重命名工作区", initial: old });
//     返回 null 表示用户取消。
//
// 宿主 <SystemDialogs /> 由 App 挂一次；没挂载时直接返回取消，不会卡住调用方。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用红色。 */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** 返回空字符串是否允许提交（默认不允许，确认按钮置灰）。 */
  allowEmpty?: boolean;
}

type Request =
  | { id: number; kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { id: number; kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

let enqueue: ((request: Request) => void) | null = null;
let nextId = 1;

/** 弹一个确认框；返回用户是否确认。 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  if (!enqueue) return Promise.resolve(false);
  return new Promise((resolve) => enqueue?.({ id: nextId++, kind: "confirm", options, resolve }));
}

/** 弹一个输入框；取消返回 null。 */
export function askPrompt(options: PromptOptions): Promise<string | null> {
  if (!enqueue) return Promise.resolve(null);
  return new Promise((resolve) => enqueue?.({ id: nextId++, kind: "prompt", options, resolve }));
}

/** 挂在 App 根节点上；同一时刻只显示队首，关掉后自动显示下一个。 */
export function SystemDialogs() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [value, setValue] = useState("");

  useEffect(() => {
    enqueue = (request) => setQueue((prev) => [...prev, request]);
    return () => {
      enqueue = null;
    };
  }, []);

  const current = queue[0] ?? null;

  useEffect(() => {
    if (current?.kind === "prompt") setValue(current.options.initial ?? "");
  }, [current]);

  const finish = useCallback(
    (result: boolean | string | null) => {
      setQueue((prev) => {
        const [head, ...rest] = prev;
        if (!head) return prev;
        if (head.kind === "confirm") (head.resolve as (v: boolean) => void)(Boolean(result));
        else (head.resolve as (v: string | null) => void)(typeof result === "string" ? result : null);
        return rest;
      });
    },
    [],
  );

  if (!current) return null;
  return current.kind === "confirm" ? (
    <ConfirmDialog request={current} onFinish={finish} />
  ) : (
    <PromptDialog request={current} value={value} onValue={setValue} onFinish={finish} />
  );
}

function ConfirmDialog({ request, onFinish }: { request: Extract<Request, { kind: "confirm" }>; onFinish: (v: boolean) => void }) {
  const t = useT();
  const { title, message, confirmText, cancelText, danger } = request.options;
  return (
    <Dialog
      open
      onClose={() => onFinish(false)}
      label={title}
      title={title}
      size="sm"
      bodyClassName="px-4 py-3"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => onFinish(false)}>
            {cancelText ?? t("取消", "Cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} autoFocus onClick={() => onFinish(true)}>
            {confirmText ?? t("确定", "Confirm")}
          </Button>
        </div>
      }
    >
      {message ? <div className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink-2">{message}</div> : null}
    </Dialog>
  );
}

function PromptDialog({
  request,
  value,
  onValue,
  onFinish,
}: {
  request: Extract<Request, { kind: "prompt" }>;
  value: string;
  onValue: (v: string) => void;
  onFinish: (v: string | null) => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const { title, message, placeholder, confirmText, cancelText, allowEmpty } = request.options;
  const blocked = !allowEmpty && value.trim() === "";

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    if (blocked) return;
    onFinish(value);
  };

  return (
    <Dialog
      open
      onClose={() => onFinish(null)}
      label={title}
      title={title}
      size="sm"
      bodyClassName="px-4 py-3"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => onFinish(null)}>
            {cancelText ?? t("取消", "Cancel")}
          </Button>
          <Button variant="primary" disabled={blocked} onClick={submit}>
            {confirmText ?? t("确定", "Confirm")}
          </Button>
        </div>
      }
    >
      {message ? <p className="mb-2 text-[12px] leading-relaxed text-muted">{message}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-[10px] border border-line-strong bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand/60"
          aria-label={title}
        />
      </form>
    </Dialog>
  );
}
