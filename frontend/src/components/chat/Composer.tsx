import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandInfo, WireAttachment } from "../../transport/types";
import { useAppStore } from "../../store/useAppStore";
import { commandDescription, permissionLabel } from "../../lib/labels";
import { pickFnosFiles } from "../../lib/fnos";
import { useLocale, useT } from "../../lib/i18n";
import type { ModelOption } from "../../lib/providerForm";
import {
  ATTACHMENT_ACCEPT,
  MAX_TOTAL_BYTES,
  attachmentFromBase64,
  classifyAttachment,
  formatBytes,
  readAttachment,
  toWireAttachment,
  type PendingAttachment,
} from "../../lib/attachments";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { askConfirm } from "../common/SystemDialogs";
import { isDangerousPermissionMode, permissionModeWarning } from "../../lib/permissionModes";
import { Menu, type MenuItem } from "../common/Menu";
import { IconClock, IconClose, IconFile, IconFolder, IconPlus, IconSend, IconShield, IconStop, IconTrash } from "../common/Icons";
import { ModelMenu } from "./ModelMenu";
import type { QueuedPrompt } from "../../lib/queue";

interface Props {
  disabled: boolean;
  /** 连接断开时只禁用发送，保留输入框里的草稿与焦点。 */
  sendBlocked: boolean;
  starting: boolean;
  commands: CommandInfo[];
  busy: boolean;
  /** 待发送队列（回合进行中提交的消息），显示在输入框上方，可改可删。 */
  queued: QueuedPrompt[];
  placeholder?: string;
  modelOptions: ModelOption[];
  selectedKey: string;
  selectedEffort: string;
  permissionMode: string;
  onSelectModel: (provider: string, model: string) => void;
  onSelectEffort: (effort: string) => void;
  onPermissionMode: (mode: string) => void;
  /** 返回 false 表示没发出去（连接断开等），此时输入框必须保留草稿与附件。 */
  onSend: (
    text: string,
    attachments: WireAttachment[],
    opts?: { priority?: "now" },
  ) => Promise<boolean>;
  /** 只入队，不立刻写给 claude（回合进行中按 Enter 走这里）。 */
  onQueue: (text: string, attachments: WireAttachment[]) => boolean;
  onDropQueued: (id: string) => void;
  /** 改一条待发送（位置不变）；正文与附件都清空时后端会把它删掉。 */
  onEditQueued: (id: string, text: string, attachments: WireAttachment[]) => void;
  /** 进入/退出某条待发送的编辑态（编辑期间后端按住自动发送）。 */
  onEditingQueued: (id: string | null) => void;
  /** 把一条待发送消息立刻写进 stdin（插话，CLI 会在下一个工具边界并入本轮）。 */
  onSteerQueued: (id: string) => void;
  onInterrupt: () => void;
  footer?: ReactNode;
}

/** 权限模式选项。没有「空模式」：空值与 default 等价，单列一项只会让人以为有两种默认。 */
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

/** 输入卡：Enter 发送、Shift+Enter 换行；"/" 唤起命令补全。 */
export function Composer({
  disabled,
  sendBlocked,
  starting,
  commands,
  busy,
  queued,
  placeholder,
  modelOptions,
  selectedKey,
  selectedEffort,
  permissionMode,
  onSelectModel,
  onSelectEffort,
  onPermissionMode,
  onSend,
  onQueue,
  onDropQueued,
  onEditQueued,
  onEditingQueued,
  onSteerQueued,
  onInterrupt,
  footer,
}: Props) {
  const t = useT();
  const locale = useLocale();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // 待发送的面板里同一时刻只展开一个编辑框（entries 是异步来的，id 对不上就自动收起）。
  const [editingQueued, setEditingQueued] = useState<{ id: string; text: string; attachments: WireAttachment[] } | null>(
    null,
  );
  const ref = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const readHostFile = useAppStore((s) => s.readHostFile);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  useEffect(() => {
    const el = editRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editingQueued?.id]);

  // 正在编辑的那条被发出去 / 被删掉了（队列是异步变的）：收起编辑框，别对着空行发呆。
  useEffect(() => {
    if (editingQueued && !queued.some((q) => q.id === editingQueued.id)) {
      setEditingQueued(null);
      onEditingQueued(null);
    }
  }, [queued, editingQueued, onEditingQueued]);

  // 组件卸载（切对话、关面板）时必须放开按住：否则那条消息永远不会被自动发出去。
  useEffect(() => () => onEditingQueued(null), [onEditingQueued]);

  const suggestions = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ")) return [];
    const q = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [text, commands]);

  // 补全列表和「+ → 指令」共用同一份中文说明，别一个中文一个英文。
  const suggestionRows = useMemo(
    () => suggestions.map((c) => ({ ...c, desc: commandDescription(c.name, c.description, locale) })),
    [suggestions, locale],
  );

  /** 输入框里有没有东西（正文或附件）：决定进行中时主按钮是「发送」还是「中断」。 */
  const hasDraft = Boolean(text.trim()) || files.length > 0;

  const submit = async (immediate = false) => {
    const value = text.trim();
    // sendBlocked = 会话还没就绪 / WS 未打开。按钮的 disabled 里本来就有它，
    // 但 Enter 直接走 submit，不在这里拦一道就会出现「按了没反应还把草稿清了」。
    if ((!value && files.length === 0) || disabled || sendBlocked) return;
    const wire = files.map(toWireAttachment);
    // 回合进行中 Enter 只入队（可改、可删），Ctrl+Enter 才是立刻插话；
    // 队列里还压着消息时新消息也一律排队尾，否则会插到前面那条之前。
    const queuedSend = !immediate && (busy || queued.length > 0);
    if (queuedSend) {
      if (!onQueue(value, wire)) return;
    } else if (!(await onSend(value, wire, immediate && busy ? { priority: "now" } : undefined))) {
      return; // 失败：草稿与已读入内存的附件原样保留
    }
    setText("");
    setFiles([]);
    setFileError(null);
    const el = ref.current;
    if (el) el.style.height = "auto";
  };

  /** 点一下待发送消息：就地展开编辑框（位置不变，改完这一轮结束照样按原顺序发）。 */
  const startEdit = (item: QueuedPrompt) => {
    setEditingQueued({ id: item.id, text: item.text, attachments: item.attachments });
    onEditingQueued(item.id);
  };

  const stopEdit = () => {
    setEditingQueued(null);
    onEditingQueued(null);
  };

  /** 编辑态直接丢弃这一条（等价于清空后保存，但一步到位）。 */
  const deleteEditing = () => {
    if (!editingQueued) return;
    onDropQueued(editingQueued.id);
    stopEdit();
  };

  const commitEdit = () => {
    if (!editingQueued) return;
    // 正文和附件都清空 = 用户想把这条丢掉，交给 updatePrompt 删。
    onEditQueued(editingQueued.id, editingQueued.text, editingQueued.attachments);
    stopEdit();
  };

  /**
   * 切换权限模式：危险模式先二次确认。
   *
   * 「不询问」「跳过权限」会让命令不经审批直接跑，误点一次就可能已经执行完了，
   * 所以这里必须拦一道，并在弹窗里说清楚区别。
   */
  const changeMode = async (next: string) => {
    if (next !== permissionMode && isDangerousPermissionMode(next)) {
      const warn = permissionModeWarning(next, locale);
      const ok = await askConfirm({
        title: warn.title,
        message: warn.message,
        danger: true,
        confirmText: t("仍然切换", "Switch anyway"),
        cancelText: t("保持当前模式", "Keep current"),
      });
      if (!ok) return;
    }
    onPermissionMode(next);
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

  /** 在光标处插入片段（命令、路径引用），并把光标停在片段之后。 */
  const insertAtCaret = (snippet: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(`${text.slice(0, start)}${snippet}${text.slice(end)}`);
    requestAnimationFrame(() => {
      const pos = start + snippet.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  /**
   * 「从飞牛选择」：选择器挑完即授权给本应用，返回 NAS 上的绝对路径。
   *
   * 图片/PDF 由后端读成附件（只放行这两类，见 /api/fs/host-file）；其余类型
   * 作为路径引用写进消息，让 claude 自己用 Read 工具去读——不做任意宿主文件读取。
   */
  const pickFromFnos = async () => {
    setFileError(null);
    const picked = await pickFnosFiles({
      title: t("选择文件", "Choose files"),
      okText: t("选择", "Choose"),
    });
    if (picked.state === "skipped") {
      setFileError(
        picked.reason === "bridge"
          ? t("飞牛宿主连接不可用，请稍后重试，或改用「本地文件/图片」。", "The fnOS host is not responding; retry later or use a local file.")
          : t("当前不在飞牛宿主中，无法打开飞牛文件选择器；可以用「本地文件/图片」。", "Not running inside fnOS, so the fnOS picker is unavailable; use a local file instead."),
      );
      return;
    }
    if (picked.state === "denied") {
      if (picked.reason === "message") setFileError(t(`飞牛文件选择失败：${picked.message}`, `fnOS file pick failed: ${picked.message}`));
      return;
    }

    const refs: string[] = [];
    const next = [...files];
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const path of picked.paths) {
      const name = path.split("/").pop() || path;
      const kind = classifyAttachment(name, "");
      if (kind !== "image" && kind !== "pdf") {
        refs.push(path);
        continue;
      }
      try {
        const host = await readHostFile(path);
        const attachment = attachmentFromBase64(host, locale);
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
    if (refs.length > 0) insertAtCaret(`${refs.join("\n")}\n`);
  };

  const addItems: MenuItem[] = [
    {
      id: "local",
      group: t("添加", "Add"),
      label: t("本地文件/图片", "Local file or image"),
      hint: "file",
      icon: <IconFile size={13} />,
      onSelect: () => fileRef.current?.click(),
    },
    {
      id: "fnos",
      label: t("从飞牛选择", "Choose in fnOS"),
      hint: "fnos",
      icon: <IconFolder size={13} />,
      onSelect: () => void pickFromFnos(),
    },
  ];

  const commandItems: MenuItem[] = commands.map((c) => {
    const desc = commandDescription(c.name, c.description, locale);
    return {
      id: `cmd:${c.name}`,
      group: t("指令", "Commands"),
      label: (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-ink">/{c.name}</span>
          {desc && <span className="min-w-0 truncate text-[10.5px] text-faint">{desc}</span>}
        </span>
      ),
      hint: c.argumentHint,
      onSelect: () => insertAtCaret(`/${c.name} `),
    };
  });

  /** 待发送的一行（只读态）：点正文进入编辑，右侧立即发 / 删除。 */
  const queuedRow = (q: QueuedPrompt) => (
    <li key={q.id} className="flex items-start gap-1 rounded-md px-1 py-1 hover:bg-panel-strong/60">
      <button
        type="button"
        onClick={() => startEdit(q)}
        className="min-w-0 flex-1 text-left"
        title={t("点一下编辑这条", "Click to edit")}
      >
        <span className="chat-text line-clamp-2 block whitespace-pre-wrap break-words leading-5 text-ink">
          {q.text || t("（仅附件）", "(attachments only)")}
        </span>
        {q.attachments.length > 0 && (
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-faint">
            <IconFile size={10} />
            {t(`${q.attachments.length} 个附件`, `${q.attachments.length} attachments`)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => onSteerQueued(q.id)}
        disabled={sendBlocked}
        className="mt-0.5 rounded p-0.5 text-muted hover:text-brand disabled:opacity-40"
        aria-label={busy ? t("立即插话", "Interject now") : t("发送这条", "Send this now")}
        title={
          busy
            ? t(
                "立即插话：写进 stdin，CLI 会在下一个工具边界并入本轮",
                "Interject now: written to stdin, merged at the next tool boundary",
              )
            : t("发送这条", "Send this now")
        }
      >
        <IconSend size={13} />
      </button>
      <button
        type="button"
        onClick={() => onDropQueued(q.id)}
        className="mt-0.5 rounded p-0.5 text-muted hover:bg-danger/10 hover:text-danger"
        aria-label={t("删除这条待发送", "Remove this queued message")}
        title={t("删除这条", "Delete this")}
      >
        <IconTrash size={13} />
      </button>
    </li>
  );

  /** 待发送的一行（编辑态）：Enter 保存、Shift+Enter 换行、Esc 取消；附件可逐个移除。 */
  const editingRow = (q: QueuedPrompt) => {
    if (!editingQueued) return null;
    return (
      <li key={q.id} className="my-1 rounded-md border border-line-strong bg-canvas/60 px-1.5 py-1">
        <textarea
          ref={editRef}
          rows={1}
          value={editingQueued.text}
          aria-label={t("编辑待发送消息", "Edit queued message")}
          onChange={(e) => setEditingQueued({ ...editingQueued, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              stopEdit();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commitEdit();
            }
          }}
          className="chat-text w-full resize-none bg-transparent px-1 leading-5 text-ink outline-none"
        />
        {editingQueued.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {editingQueued.attachments.map((a, i) => (
              <span
                key={`${a.name}-${i}`}
                className="flex max-w-full items-center gap-1 rounded border border-line bg-canvas/60 px-1.5 py-0.5 text-[10px] text-muted"
              >
                <IconFile size={10} />
                <span className="max-w-[9rem] truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setEditingQueued({
                      ...editingQueued,
                      attachments: editingQueued.attachments.filter((_, j) => j !== i),
                    })
                  }
                  className="rounded text-faint hover:text-danger"
                  aria-label={t(`移除附件 ${a.name}`, `Remove attachment ${a.name}`)}
                >
                  <IconClose size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          <Button size="sm" variant="primary" onClick={commitEdit}>
            {t("保存", "Save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={stopEdit}>
            {t("取消", "Cancel")}
          </Button>
          {/* 编辑态里也要能删：清空正文再保存也是一种删法，但那要两步，这里给一步的入口。 */}
          <button
            type="button"
            onClick={deleteEditing}
            className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-[10px] px-2.5 py-1.5 text-[11.5px] font-medium text-danger hover:bg-danger/10"
            aria-label={t("删除这条待发送", "Remove this queued message")}
            title={t("删除这条", "Delete this")}
          >
            <IconTrash size={12} />
            {t("删除", "Delete")}
          </button>
          <span className="ml-auto text-[10px] text-faint">{t("Enter 保存 · Esc 取消", "Enter saves · Esc cancels")}</span>
        </div>
      </li>
    );
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
      {suggestionRows.length > 0 && (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-line bg-canvas p-1 shadow-soft">
          {suggestionRows.map((c) => (
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
              {c.desc && <span className="ml-auto max-w-[55%] truncate text-[11px] text-muted">{c.desc}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="composer-card px-3 pb-2.5 pt-2">
        {/* 待发送：回合进行中提交的消息。放在输入框上方；点正文就地改，右侧箭头立刻发。 */}
        {queued.length > 0 && (
          <div className="mb-2 rounded-lg border border-line bg-panel/40">
            <div className="flex items-center gap-1.5 px-2 pt-1.5 text-[10px] text-faint">
              <IconClock size={11} className="shrink-0" />
              <span className="min-w-0 truncate">
                {t(`待发送 ${queued.length} 条`, `${queued.length} queued`)}
                {" · "}
                {busy
                  ? t("本轮结束后自动发送", "sent when this turn ends")
                  : t("空闲中，点右侧箭头逐条发送", "idle — the arrow sends it now")}
              </span>
            </div>
            <ul className="px-1 pb-1 pt-0.5">
              {queued.map((q) => (editingQueued?.id === q.id ? editingRow(q) : queuedRow(q)))}
            </ul>
          </div>
        )}
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
              // Ctrl/⌘+Enter = 立刻插话（回合进行中直接写 stdin），Enter = 排队。
              void submit(e.ctrlKey || e.metaKey);
            }
          }}
          placeholder={hint}
          aria-label={t("消息输入框", "Message input")}
          className="composer-textarea chat-text w-full bg-transparent px-1 leading-6 text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />

        <div className="mt-1.5 flex items-center gap-1 sm:gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              const anchor = e.currentTarget;
              setMenuAnchor((prev) => (prev ? null : anchor));
            }}
            disabled={disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-40"
            aria-label={t("添加", "Add")}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            title={t("添加文件、图片或指令", "Add files, images or commands")}
          >
            <IconPlus size={17} />
          </button>
          <Menu
            open={menuAnchor !== null}
            anchor={menuAnchor}
            items={[...addItems, ...commandItems]}
            onClose={() => setMenuAnchor(null)}
            width={320}
            align="start"
          />

          <span className="shrink-0" title={t("权限模式", "Permission mode")}>
            <Select
              variant="ghost"
              ariaLabel={t("权限模式", "Permission mode")}
              value={permissionMode || "default"}
              onChange={(next) => void changeMode(next)}
              disabled={disabled}
              leading={<IconShield size={13} className="shrink-0" />}
              options={PERMISSION_MODES.map((m) => ({
                value: m,
                label: permissionLabel(m, locale),
                danger: isDangerousPermissionMode(m),
              }))}
              menuWidth={176}
            />
          </span>

          <span className="min-w-0 flex-1" title={t("模型与推理等级", "Model and reasoning level")}>
            <ModelMenu
              options={modelOptions}
              selectedKey={selectedKey}
              selectedEffort={selectedEffort}
              disabled={disabled}
              onSelectModel={onSelectModel}
              onSelectEffort={onSelectEffort}
            />
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* 回合进行中：草稿一有内容，主按钮就从「中断」换成「发送（排队）」——
                手机键盘上的回车是换行，没有这个按钮就没法插话；中断退成左边的小圆钮，
                输入框里打着字也照样能停。 */}
            {busy && (
              <button
                type="button"
                onClick={onInterrupt}
                disabled={sendBlocked}
                className={`send-button is-stop disabled:opacity-40 ${hasDraft ? "is-compact" : ""}`}
                aria-label={t("中断本轮", "Stop this turn")}
                title={t("中断本轮（已经完成的工作会保留）", "Stop this turn (finished work is kept)")}
              >
                <IconStop size={hasDraft ? 12 : 15} />
              </button>
            )}
            {(!busy || hasDraft) && (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={disabled || sendBlocked || !hasDraft}
                className="send-button"
                aria-label={busy ? t("发送并排队", "Send, queued for this turn") : t("发送", "Send")}
                title={
                  busy
                    ? t(
                        "发送：本轮结束后自动发出（Ctrl/⌘+Enter 立即插话）",
                        "Send: delivered when this turn ends (Ctrl/⌘+Enter interjects now)",
                      )
                    : t("发送（Enter）", "Send (Enter)")
                }
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
