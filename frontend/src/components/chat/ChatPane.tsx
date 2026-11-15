import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { OverviewPanel } from "./OverviewPanel";
import { TopBar, type ChatTab } from "../layout/TopBar";
import { PermissionPanel } from "../permission/PermissionPanel";
import type { PermissionPayload } from "../../transport/types";
import { sessionTitle } from "../../lib/labels";
import { effortFor, findOption, modelOptionsFromSettings } from "../../lib/providerForm";
import { sessionToMarkdown } from "../../lib/sessionExport";
import { copyText } from "../../lib/clipboard";
import { useLocale, useT } from "../../lib/i18n";
import { IconAlert, IconFolderPlus, IconRetry, IconSpark } from "../common/Icons";

interface Props {
  onToggleSidebar: () => void;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onAddWorkspace: () => void;
}

export function ChatPane({ onToggleSidebar, onToggleCollapse, onOpenSettings, onAddWorkspace }: Props) {
  const t = useT();
  const locale = useLocale();
  const info = useAppStore((s) => s.info);
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const items = useAppStore((s) => s.items);
  const perms = useAppStore((s) => s.perms);
  const inits = useAppStore((s) => s.inits);
  const states = useAppStore((s) => s.states);
  const conns = useAppStore((s) => s.conns);
  const settings = useAppStore((s) => s.settings);
  const starting = useAppStore((s) => s.starting);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const interrupt = useAppStore((s) => s.interrupt);
  const selectModel = useAppStore((s) => s.selectModel);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  const replyPermission = useAppStore((s) => s.replyPermission);
  const retryConnection = useAppStore((s) => s.retryConnection);
  const createSession = useAppStore((s) => s.createSession);

  const [tab, setTab] = useState<ChatTab>("chat");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [mode, setModeState] = useState("");

  const session = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const itemList = activeId ? (items[activeId] ?? []) : [];
  const init = activeId ? inits[activeId] : undefined;
  const conn = activeId ? (conns[activeId] ?? { state: "idle" as const }) : { state: "idle" as const };
  const state = activeId ? (states[activeId] ?? session?.state ?? "idle") : "idle";
  const busy = state === "busy";
  const title = session ? sessionTitle(session.cwd, itemList, locale) : t("新对话", "New chat");

  useEffect(() => {
    setModeState(init?.current_permission_mode ?? settings?.permission_mode ?? "");
  }, [init?.current_permission_mode, settings?.permission_mode, activeId]);

  useEffect(() => {
    if (!activeId) setTab("chat");
  }, [activeId]);

  useEffect(() => {
    document.title = session ? title : "Claude Code";
  }, [session, title]);

  const pending = useMemo(
    () => (activeId ? (perms[activeId] ?? []).filter((p) => !dismissed.has(p.request_id)) : []),
    [perms, activeId, dismissed],
  );

  const handleReply = (
    perm: PermissionPayload,
    opts: { allow: boolean; updatedInput?: unknown; updatedPermissions?: unknown; message?: string },
  ) => {
    if (opts.allow && opts.updatedPermissions && (opts.updatedPermissions as { type?: string }).type === "setMode") {
      const next = (opts.updatedPermissions as { mode?: string }).mode;
      if (next) {
        setModeState(next);
        setPermissionMode(next);
      }
    }
    replyPermission(perm, opts.allow, opts.updatedInput, opts.updatedPermissions, opts.message);
    setDismissed((prev) => new Set(prev).add(perm.request_id));
  };

  const modelOptions = useMemo(() => modelOptionsFromSettings(settings), [settings]);
  const selected = settings?.selected;
  const selectedKey = selected && selected.provider && selected.model ? `${selected.provider}/${selected.model}` : "";
  const selectedOption = findOption(modelOptions, selected?.provider ?? "", selected?.model ?? "");
  const selectedEffort = effortFor(selectedOption?.spec, selected?.effort);
  const mismatch = Boolean(session?.provider) && Boolean(selected?.provider) && session!.provider !== selected!.provider;

  const canSend = Boolean(activeId || currentWorkspace);
  const disabled = starting || !canSend;
  const sendBlocked = Boolean(activeId) && conn.state !== "open";
  const placeholder = !currentWorkspace
    ? t("先添加一个授权目录", "Add an authorized directory first")
    : starting
      ? t("正在启动 Claude…", "Starting Claude…")
      : sendBlocked
        ? t("连接断开，正在自动重连…", "Disconnected, reconnecting…")
        : !activeId
          ? t("输入消息即可开始", "Type a message to start")
          : undefined;

  const tools = itemList.filter((i) => i.kind === "tool").length;
  const effortMismatch = Boolean(activeId && selectedEffort && session && session.effort !== selectedEffort);
  const footer = (
    <>
      <span className="truncate">
        {effortMismatch
          ? t("推理强度将在新会话生效", "Reasoning effort applies to new sessions")
          : busy ? t("Claude 正在工作，可随时中断", "Claude is working; interrupt anytime") : starting ? t("正在启动 Claude…", "Starting Claude…") : (
            <>
              <span className="hidden sm:inline">{t("Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for newline")}</span>
              <span className="sm:hidden">{t("点右下角发送 · / 唤起命令", "Tap send · / commands")}</span>
            </>
          )}
      </span>
      <span className="shrink-0">
        {itemList.length > 0 ? t(`${itemList.length} 条事件 · ${tools} 次工具`, `${itemList.length} events · ${tools} tools`) : ""}
      </span>
    </>
  );

  const copySession = async (): Promise<boolean> => {
    if (!session) return false;
    const markdown = sessionToMarkdown({
      title,
      cwd: session.cwd,
      items: itemList,
      locale,
    });
    return copyText(markdown);
  };

  const newChat = () => {
    if (currentWorkspace) void createSession(currentWorkspace);
    else onAddWorkspace();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <TopBar
        session={session}
        title={title}
        conn={conn}
        busy={busy}
        tab={tab}
        mode={mode}
        onTab={setTab}
        onToggleSidebar={onToggleSidebar}
        onToggleCollapse={onToggleCollapse}
        onOpenSettings={onOpenSettings}
        onCopySession={copySession}
      />

      {activeId && conn.state !== "open" && conn.state !== "idle" && (
        <div
          className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px] md:px-4 ${
            conn.state === "closed"
              ? "border-rose-200 bg-rose-50 text-danger dark:border-rose-900/50 dark:bg-rose-950/30"
              : "border-amber-200 bg-amber-50 text-warn dark:border-amber-900/50 dark:bg-amber-950/25"
          }`}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${conn.state === "closed" ? "bg-danger" : "bg-warn"}`} />
          <span className="min-w-0 truncate">
            {conn.state === "closed"
              ? t("连接已关闭", "Connection closed")
              : conn.state === "reconnecting"
                ? t(`连接已断开，正在自动重连${conn.attempt ? `（第 ${conn.attempt} 次）` : ""}…`, `Disconnected, reconnecting${conn.attempt ? ` (attempt ${conn.attempt})` : ""}…`)
                : t("正在连接…", "Connecting…")}
            {conn.delayMs ? t(` ${Math.max(1, Math.ceil(conn.delayMs / 1000))}s 后重试`, ` retrying in ${Math.max(1, Math.ceil(conn.delayMs / 1000))}s`) : ""}
          </span>
          <button
            type="button"
            onClick={() => activeId && retryConnection(activeId)}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-current/20 px-2 py-0.5 font-medium hover:bg-black/5"
          >
            <IconRetry size={11} />
            {t("立即重试", "Retry now")}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "overview" ? (
          <OverviewPanel
            session={session}
            init={init}
            settings={settings}
            info={info}
            conn={conn}
            mode={mode}
            state={state}
            items={itemList}
            currentWorkspace={currentWorkspace}
            onNewChat={newChat}
            onOpenSettings={onOpenSettings}
          />
        ) : activeId ? (
          <MessageList items={itemList} empty={t("开始新的对话", "Start a new conversation")} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-[20px] bg-brand-soft text-brand">
              <IconSpark size={26} />
            </span>
            <h2 className="text-[18px] font-semibold tracking-tight text-ink">
              {starting ? t("正在启动 Claude…", "Starting Claude…") : currentWorkspace ? t("开始新的对话", "Start a new conversation") : t("先添加授权目录", "Add an authorized directory first")}
            </h2>
            <p className="max-w-sm text-[12px] leading-relaxed text-muted">
              {starting
                ? t("后端正在拉起 claude 子进程，完成后即可发送消息。", "The backend is starting the claude process; you can send once it is ready.")
                : currentWorkspace
                  ? t("在下方输入消息即可自动启动会话；也可以从左侧切换工作区。", "Type below to start automatically, or switch workspaces from the sidebar.")
                  : t("授权一个目录作为工作区，Claude 会在其中读写文件、执行命令。", "Authorize a directory as a workspace; Claude will read, write and run commands there.")}
            </p>
            {!currentWorkspace && (
              <button
                type="button"
                onClick={onAddWorkspace}
                className="mt-1 flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12px] font-medium text-canvas hover:opacity-90"
              >
                <IconFolderPlus size={15} />
                {t("添加授权目录", "Add authorized directory")}
              </button>
            )}
            {currentWorkspace && (
              <p className="max-w-full truncate rounded-full border border-line px-3 py-1 font-mono text-[10.5px] text-muted" title={currentWorkspace}>
                {currentWorkspace}
              </p>
            )}
          </div>
        )}
      </div>

      {tab === "chat" && (
        <>
          {mismatch && (
            <div className="mx-auto flex w-full max-w-[820px] items-start gap-2 px-4 pb-1 text-[11px] text-warn md:px-6">
              <IconAlert size={13} className="mt-0.5 shrink-0" />
              {t(`当前会话使用的是「${session?.provider}」，与所选模型的提供商不同。切换提供商的模型需要新建会话。`, `This session uses "${session?.provider}", which differs from the selected model's provider. Start a new session to switch providers.`)}
            </div>
          )}

          {pending.length > 0 && (
            <div className="dsh-scroll mx-auto max-h-[38vh] w-full max-w-[820px] shrink-0 overflow-y-auto px-3 pt-2 md:px-6">
              <div className="space-y-2">
                {pending.map((p) => (
                  <PermissionPanel key={p.request_id} perm={p} onReply={(opts) => handleReply(p, opts)} />
                ))}
              </div>
            </div>
          )}

          <div className="shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2 md:px-6 md:pb-4">
            <div className="mx-auto w-full max-w-[820px]">
              <Composer
                disabled={disabled}
                sendBlocked={sendBlocked}
                starting={starting}
                commands={init?.commands ?? []}
                busy={busy}
                placeholder={placeholder}
                modelOptions={modelOptions}
                selectedKey={selectedKey}
                selectedEffort={selectedEffort}
                permissionMode={mode}
                onSelectModel={(provider, model) => {
                  const opt = findOption(modelOptions, provider, model);
                  void selectModel(provider, model, effortFor(opt?.spec, undefined));
                }}
                onSelectEffort={(effort) => {
                  if (selected?.provider && selected.model) void selectModel(selected.provider, selected.model, effort);
                }}
                onPermissionMode={(m) => {
                  setModeState(m);
                  setPermissionMode(m);
                }}
                onSend={(text, attachments) => void sendPrompt(text, attachments, t("附件：", "File: "))}
                onInterrupt={interrupt}
                footer={footer}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
