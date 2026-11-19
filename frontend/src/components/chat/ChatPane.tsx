import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useSidebarStore } from "../../store/useSidebarStore";
import { Composer } from "./Composer";
import { TaskPanel } from "./TaskPanel";
import { MessageList } from "./MessageList";
import { TurnTimer } from "./TurnTimer";
import { WorkspacePicker } from "./WorkspacePicker";
import { UsageStats, UsageSummary } from "./UsageStats";
import { TopBar } from "../layout/TopBar";
import { PermissionPanel } from "../permission/PermissionPanel";
import { AskUserQuestionPanel } from "../permission/AskUserQuestionPanel";
import type { PermissionPayload } from "../../transport/types";
import { conversationTitle } from "../../lib/labels";
import { workspaceFor } from "../../lib/conversations";
import { canRevealInFnos, fnosHostAvailable } from "../../lib/fnos";
import { isNewChat } from "../../lib/newChat";
import { effortFor, findOption, modelOptionsFromSettings } from "../../lib/providerForm";
import { sessionToMarkdown } from "../../lib/sessionExport";
import { copyText } from "../../lib/clipboard";
import { downloadFile, sessionLogName } from "../../lib/download";
import { useLocale, useT } from "../../lib/i18n";
import { BrandMark, IconAlert, IconRetry } from "../common/Icons";
import { backgroundTasks, subagentsOnly } from "../../lib/backgroundTasks";
import { draftKeyFor } from "../../lib/drafts";
import { MarkdownMediaContext, type MarkdownMedia } from "../common/Markdown";
import { ImageLightbox } from "./ImageLightbox";

interface Props {
  onToggleSidebar: () => void;
  onAddWorkspace: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
}

export function ChatPane({ onToggleSidebar, onAddWorkspace, rightOpen, onToggleRight }: Props) {
  const t = useT();
  const locale = useLocale();
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);
  const conversations = useAppStore((s) => s.conversations);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const startConversationIn = useAppStore((s) => s.startConversationIn);
  const showSubagent = useAppStore((s) => s.showSubagent);
  const items = useAppStore((s) => s.items);
  const perms = useAppStore((s) => s.perms);
  const inits = useAppStore((s) => s.inits);
  const states = useAppStore((s) => s.states);
  const modes = useAppStore((s) => s.modes);
  const conns = useAppStore((s) => s.conns);
  const settings = useAppStore((s) => s.settings);
  const usage = useAppStore((s) => s.usage);
  const starting = useAppStore((s) => s.starting);
  const queuedMap = useAppStore((s) => s.queued);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const enqueuePrompt = useAppStore((s) => s.enqueuePrompt);
  const dropQueued = useAppStore((s) => s.dropQueued);
  const editQueued = useAppStore((s) => s.editQueued);
  const setEditingQueued = useAppStore((s) => s.setEditingQueued);
  const steerQueued = useAppStore((s) => s.steerQueued);
  const interrupt = useAppStore((s) => s.interrupt);
  const selectModel = useAppStore((s) => s.selectModel);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  const replyPermission = useAppStore((s) => s.replyPermission);
  const retryConnection = useAppStore((s) => s.retryConnection);
  const info = useAppStore((s) => s.info);
  const openWorkspaceInFiles = useAppStore((s) => s.openWorkspaceInFiles);

  const conversation = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  // 活着的会话才带着「进程启动时固定的」模型与推理强度；下面据此判断改了强度要不要提示。
  const liveSession = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const session = useMemo(() => {
    if (liveSession) return liveSession;
    if (!conversation) return null;
    return {
      id: conversation.id,
      cwd: conversation.cwd,
      state: conversation.state ?? "idle",
      provider: conversation.provider,
      model: conversation.model,
      effort: conversation.effort,
      last_active: conversation.last_active,
    };
  }, [liveSession, conversation]);
  const itemList = activeId ? (items[activeId] ?? []) : [];
  // 正文图片的放大查看：会话 cwd 决定相对路径的解析基准，图片本体走 /api/fs/raw。
  const [lightbox, setLightbox] = useState<{ src: string; alt: string; rel?: string } | null>(null);
  const requestOpenFile = useSidebarStore((s) => s.requestOpenFile);
  const media = useMemo<MarkdownMedia | null>(() => {
    const cwd = session?.cwd;
    if (!cwd) return null;
    return { cwd, open: (image) => setLightbox(image) };
  }, [session?.cwd]);
  // 切对话时收起灯箱：它是"上一个对话里那张图"的临时状态，留着会盖住新对话。
  useEffect(() => setLightbox(null), [activeId]);
  // 待发送队列跟着对话走：换对话就换一批（后端在回合结束时自动发队首）。
  const queued = activeId ? (queuedMap[activeId] ?? []) : [];
  // 页头两个入口：子代理（有对话可看）与后台操作（只能中止），都从消息流现算。
  // 后台操作还要后端那份 liveTasks 补 task_id（中途接入的设备没有 task_started）。
  const subs = useMemo(() => subagentsOnly(itemList), [itemList]);
  const liveTasks = useAppStore((s) => (activeId ? s.liveTasks[activeId] : undefined));
  const bgTasks = useMemo(() => backgroundTasks(itemList, liveTasks), [itemList, liveTasks]);
  const stopTask = useAppStore((s) => s.stopTask);
  const init = activeId ? inits[activeId] : undefined;
  const conn = activeId ? (conns[activeId] ?? { state: "idle" as const }) : { state: "idle" as const };
  const state = activeId ? (states[activeId] ?? session?.state ?? "idle") : "idle";
  const busy = state === "busy";
  // 本回合的起点取「最后一条用户消息的时间」：local 插入与转录回放都带时间戳，
  // 不再另存一份「回合开始时间」，免得重连、切对话后两份状态对不上。
  const turnStartedAt = useMemo(() => {
    if (!busy) return 0;
    for (let i = itemList.length - 1; i >= 0; i -= 1) {
      const it = itemList[i];
      if (it.kind === "user") return it.ts;
    }
    return 0;
  }, [busy, itemList]);
  const title = session || conversation
    ? conversationTitle(conversation?.title, itemList, locale)
    : t("新对话", "New chat");

  useEffect(() => {
    document.title = session ? title : "Claude Code";
  }, [session, title]);

  // 只认 store 里的 perms：回复成功才会从那里删掉，失败时卡片保留。
  // 组件里再存一份 dismissed 曾导致「跨会话共享 request_id 就永久吞掉新审批」。
  const pending = activeId ? (perms[activeId] ?? []) : [];

  const handleReply = (
    perm: PermissionPayload,
    opts: { allow: boolean; updatedInput?: unknown; updatedPermissions?: unknown; message?: string },
  ) => {
    if (opts.allow && opts.updatedPermissions && (opts.updatedPermissions as { type?: string }).type === "setMode") {
      const next = (opts.updatedPermissions as { mode?: string }).mode;
      if (next) setPermissionMode(next);
    }
    replyPermission(perm, opts.allow, opts.updatedInput, opts.updatedPermissions, opts.message);
  };

  // 当前权限模式以会话为准：CLI 报上来的值存在 store.modes（模型自己 ExitPlanMode、
  // 切模式回包被拒、重开后进程换了模式，都只有 CLI 知道）；没有活着的会话就看默认权限。
  const mode = activeId
    ? (modes[activeId] ?? init?.current_permission_mode ?? settings?.permission_mode ?? "")
    : (settings?.permission_mode ?? "");

  const modelOptions = useMemo(() => modelOptionsFromSettings(settings), [settings]);
  const selected = settings?.selected;
  const selectedKey = selected && selected.provider && selected.model ? `${selected.provider}/${selected.model}` : "";
  const selectedOption = findOption(modelOptions, selected?.provider ?? "", selected?.model ?? "");
  const selectedEffort = effortFor(selectedOption?.spec, selected?.effort);
  const mismatch = Boolean(session?.provider) && Boolean(selected?.provider) && session!.provider !== selected!.provider;

  // 还没开始的新对话（点了「新对话」但一条消息都没发）也用居中布局，
  // 否则新建后立刻掉回贴底布局，工作区选择器也跟着消失。
  const newChat = isNewChat(conversation, itemList.length);

  const canSend = Boolean(activeId || currentWorkspace);
  const disabled = starting || !canSend;
  const sendBlocked = Boolean(activeId) && conn.state !== "open";
  const placeholder = !currentWorkspace
    ? t("先添加一个授权目录", "Add an authorized directory first")
    : starting
      ? t("正在启动 Claude…", "Starting Claude…")
      : newChat
        ? activeId && sendBlocked
          ? t("正在启动 Claude…", "Starting Claude…")
          : t("输入消息即可开始", "Type a message to start")
        : sendBlocked
          ? t("连接断开，正在自动重连…", "Disconnected, reconnecting…")
          : undefined;

  const tools = itemList.filter((i) => i.kind === "tool").length;
  // 推理等级在进程启动时固定（CLI 没有 set_effort），store 会按同一 id 重开会话让它生效；
  // 进行中不能杀进程，所以这时只剩「等这一轮结束再重开」的过渡态需要提示。
  const effortMismatch = Boolean(liveSession && (liveSession.effort ?? "") !== selectedEffort);
  // 进行中切换只能等这一轮结束再重开；重开期间的「正在启动」由下面的 starting 分支说。
  const effortPending = effortMismatch && busy;

  // 用量只显示 CLI 真的给出的数字（换算与文案见 UsageStats / lib/usage）。
  // 转录回放时 store 里没有实时快照，就退回最后一条 result 上挂的那份。
  const liveUsage = activeId ? usage[activeId] : undefined;
  const lastResultUsage = [...itemList].reverse().find((i) => i.kind === "result")?.usage;
  // 窗口优先用 CLI 在 result.modelUsage 里给的；转录还原时拿不到，退回设置里配的模型窗口。
  const windowFromSettings = selectedOption?.spec.context_window;
  const base = liveUsage ?? lastResultUsage;
  const snap =
    base && base.contextWindow === undefined && windowFromSettings
      ? { ...base, contextWindow: windowFromSettings }
      : base;
  // 「轮」用用户消息数：重开对话时转录里没有 result 行，用 result 计数会归零。
  const turns = itemList.filter((i) => i.kind === "user").length;

  const footer = (
    <>
      <span className="truncate">
        {starting ? t("正在启动 Claude…", "Starting Claude…")
          : effortPending
            ? t("本轮结束后按新的推理等级重开（上下文保留）", "Reopening with the new reasoning level after this turn")
            : effortMismatch ? t("推理等级将在重开会话后生效", "Reasoning level applies after the session reopens")
            : busy ? (
              <>
                <span className="hidden sm:inline">
                  {t(
                    queued.length > 0
                      ? `Claude 正在工作 · ${queued.length} 条待发送`
                      : "Claude 正在工作 · Enter 排队 · Ctrl+Enter 立即插话",
                    queued.length > 0
                      ? `Claude is working · ${queued.length} queued`
                      : "Claude is working · Enter queues · Ctrl+Enter interjects",
                  )}
                </span>
                {/* 手机键盘的回车是换行，只能点按钮：提示写清楚按钮的作用。 */}
                <span className="sm:hidden">
                  {t(
                    queued.length > 0 ? `Claude 正在工作 · ${queued.length} 条待发送` : "Claude 正在工作 · 发送＝排队等本轮结束",
                    queued.length > 0 ? `Claude is working · ${queued.length} queued` : "Claude is working · send queues for this turn",
                  )}
                </span>
              </>
            ) : (
              <>
                <span className="hidden sm:inline">{t("Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for newline")}</span>
                <span className="sm:hidden">{t("点右下角发送 · / 唤起命令", "Tap send · / commands")}</span>
              </>
            )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <UsageSummary snap={snap} turns={turns} events={itemList.length} />
        <UsageStats snap={snap} turns={turns} tools={tools} events={itemList.length} />
      </span>
    </>
  );

  // 「在飞牛打开工作区」：目标是会话所属的工作区根目录（最长匹配），
  // 没有会话时退回落当前工作区。端口访问 / 不在宿主里时按钮不出现——
  // 那两种情况下函数调用只会得到「当前不在飞牛宿主中」。
  const revealPath = session ? workspaceFor(session.cwd, workspaces) || session.cwd : currentWorkspace;
  const showReveal = canRevealInFnos({ path: revealPath, channel: info?.channel, inHost: fnosHostAvailable() });

  /** 导出原始日志：zip 里是 claude 自己写的转录（含子代理），不经后端二次加工。 */
  const downloadSession = async (): Promise<boolean> => {
    if (!session) return false;
    try {
      await downloadFile(
        `/api/history/export?id=${encodeURIComponent(session.id)}`,
        sessionLogName(session.id),
      );
      return true;
    } catch {
      return false;
    }
  };

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

  return (
    <MarkdownMediaContext.Provider value={media}>
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <TopBar
        session={session}
        subagents={subs}
        onOpenSubagent={showSubagent}
        backgroundTasks={bgTasks}
        onStopTask={stopTask}
        title={title}
        busy={busy}
        onToggleSidebar={onToggleSidebar}
        onDownloadSession={downloadSession}
        onCopySession={copySession}
        rightOpen={rightOpen}
        onToggleRight={onToggleRight}
        showReveal={showReveal}
        onRevealWorkspace={() => void openWorkspaceInFiles(revealPath)}
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

      {activeId && !newChat && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MessageList items={itemList} resetKey={activeId ?? undefined} empty={t("开始新的对话", "Start a new conversation")} />
        </div>
      )}

      {mismatch && (
        <div className="mx-auto flex w-full max-w-[820px] items-start gap-2 px-4 pb-1 text-[11px] text-warn md:px-6">
          <IconAlert size={13} className="mt-0.5 shrink-0" />
          {t(`当前会话使用的是「${session?.provider}」，与所选模型的提供商不同。切换提供商的模型需要新建会话。`, `This session uses "${session?.provider}", which differs from the selected model's provider. Start a new session to switch providers.`)}
        </div>
      )}

      {/* 新对话（含刚点「新对话」、一条消息都没发的空会话）：输入框居中（参照 DSH
          的新对话页），上方是品牌与工作区选择器；已经有消息时才回到贴底布局。 */}
      <div
        className={
          newChat
            ? "dsh-scroll relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom,0px)+24px)] pt-6 md:px-6"
            : "relative shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2 md:px-6 md:pb-4"
        }
      >
        {/* 待审批 / 提问卡片吸附在输入框上方并**覆盖**对话区（不再占布局高度）。
            新对话页不会有待审批：还没有回合就不会有 can_use_tool，所以这里不必为
            「居中输入框」的布局单独算位置（真出现时这张卡会贴在容器上沿之外，不会被看到）。
            卡片一出现就把消息区顶上去会让正在读的位置跳一下，长卡片（模型提问最多 4 题）
            还会把输入框挤出屏幕。外层 pointer-events-none，只有卡片本身接收点击/滚轮，
            空白处的点击照常落到下面的消息上。 */}
        {pending.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 px-3 pb-2 md:px-6">
            <div className="dsh-scroll mx-auto max-h-[64dvh] w-full max-w-[820px] overflow-y-auto">
              <div className="pointer-events-auto space-y-2">
                {pending.map((p) =>
                  // 提问不是审批：它有自己的翻页 / 单选多选 / 提交自检（见 AskUserQuestionPanel）。
                  // 结构解析失败时那张卡片自己回落到通用审批面板。
                  p.tool_name === "AskUserQuestion" ? (
                    <AskUserQuestionPanel key={p.request_id} perm={p} onReply={(opts) => handleReply(p, opts)} />
                  ) : (
                    <PermissionPanel key={p.request_id} perm={p} onReply={(opts) => handleReply(p, opts)} />
                  ),
                )}
              </div>
            </div>
          </div>
        )}
        <div className="mx-auto my-auto w-full max-w-[820px]">
          {newChat && (
            <div className="mb-6 flex flex-col items-center gap-2 text-center">
              <div className="flex items-center gap-2.5">
                <BrandMark size={30} />
                {/* 顶栏在没有会话时已经写着产品名，这里再写一遍会重复，用「新对话」当标题。 */}
                <span className="text-[21px] font-semibold tracking-tight text-ink">{t("新对话", "New chat")}</span>
              </div>
              <p className="max-w-md text-[11.5px] leading-relaxed text-muted">
                {starting
                  ? t("后端正在拉起 claude 子进程，完成后即可发送消息。", "The backend is starting the claude process; you can send once it is ready.")
                  : currentWorkspace
                    ? t("输入消息即可开始新的对话。", "Type to start a new conversation.")
                    : t("授权一个目录作为工作区，Claude 会在其中读写文件、执行命令。", "Authorize a directory as a workspace; Claude will read, write and run commands there.")}
              </p>
            </div>
          )}

          {newChat && (
            <div className="mb-2 flex items-center gap-1.5">
              {/* 换工作区 = 在该目录开一条新对话：只切当前工作区会让首条消息落到
                  ensureSession 的「恢复最近对话」上，用户选了工作区却进了旧对话。 */}
              <WorkspacePicker
                workspaces={workspaces}
                current={currentWorkspace}
                disabled={starting}
                onPick={(path) => void startConversationIn(path)}
                onAdd={onAddWorkspace}
              />
            </div>
          )}

          {/* 卡片浮在输入框上方时计时器会被它盖住/顶出来，直接不渲染：那行只说明「还在跑」，
              而待审批本身就表示这一轮没结束。 */}
          {!newChat && pending.length === 0 && <TurnTimer startedAt={turnStartedAt} className="mb-1.5 px-1" />}

          {/* 任务清单贴在输入框上方（对齐 DSH）：模型用 Tasks API 维护的长期任务
              一眼能看到还剩什么，不必去聊天记录里翻 TaskCreate 卡片。 */}
          {!newChat && <TaskPanel items={itemList} />}

          <Composer
            disabled={disabled}
            sendBlocked={sendBlocked}
            starting={starting}
            commands={init?.commands ?? []}
            busy={busy}
            queued={queued}
            placeholder={placeholder}
            draftKey={draftKeyFor(activeId, currentWorkspace)}
            modelOptions={modelOptions}
            selectedKey={selectedKey}
            selectedEffort={selectedEffort}
            permissionMode={mode}
            // 补全的根跟着会话走：新对话还没 cwd 时用当前工作区（草稿本来就是按它分桶的）。
            cwd={session?.cwd ?? currentWorkspace}
            onSelectModel={(provider, model) => {
              const opt = findOption(modelOptions, provider, model);
              // 新模型也支持当前档位就沿用它；否则回到「默认」（不声明推理等级）。
              void selectModel(provider, model, effortFor(opt?.spec, selectedEffort));
            }}
            onSelectEffort={(effort) => {
              if (selected?.provider && selected.model) void selectModel(selected.provider, selected.model, effort);
            }}
            onPermissionMode={(m) => setPermissionMode(m)}
            onSend={(text, attachments, opts) => sendPrompt(text, attachments, t("附件：", "File: "), opts)}
            onQueue={(text, attachments) => enqueuePrompt(text, attachments, t("附件：", "File: "))}
            onDropQueued={dropQueued}
            onEditQueued={editQueued}
            onEditingQueued={setEditingQueued}
            onSteerQueued={(qid) => void steerQueued(qid)}
            onInterrupt={interrupt}
            footer={footer}
          />
        </div>
      </div>
    </div>
    <ImageLightbox
      // 换图/重开时重置缩放：组件在 src 为空时只 return null，state 还留着
      key={lightbox?.src ?? ""}
      src={lightbox?.src ?? null}
      alt={lightbox?.alt ?? ""}
      rel={lightbox?.rel}
      onClose={() => setLightbox(null)}
      onOpenSidebar={lightbox?.rel === undefined ? undefined : () => {
        // 先登记请求再开侧栏：RightSidebar 挂载后读 store，标签才开得出来。
        requestOpenFile(lightbox.rel as string);
        setLightbox(null);
        if (!rightOpen) onToggleRight();
      }}
    />
    </MarkdownMediaContext.Provider>
  );
}
