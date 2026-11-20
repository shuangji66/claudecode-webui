import { useState } from "react";
import type { SessionInfo } from "../../transport/types";
import { useT } from "../../lib/i18n";
import { runningSubagents, type SubagentEntry } from "../../lib/subagents";
import type { BackgroundTaskEntry } from "../../lib/backgroundTasks";
import { Menu } from "../common/Menu";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconFolder,
  IconMore,
  IconPanel,
  IconSidebarRight,
  IconSpark,
  IconStopOutline,
  IconTerminal,
} from "../common/Icons";

/** 子代理状态点配色（与侧栏对话状态点一致：进行中强调色、完成绿、失败红、停止琥珀）。 */
const SUBAGENT_TONE = {
  running: "bg-brand",
  completed: "bg-ok",
  failed: "bg-danger",
  stopped: "bg-warn",
} as const;

interface Props {
  session: SessionInfo | null;
  /** 本会话的子代理（页头「子智能体 N」触发器）。 */
  subagents: SubagentEntry[];
  onOpenSubagent: (agentId: string, label: string) => void;
  /**
   * 还在后台跑、但不是子代理的操作（后台命令 / MCP 调用）。
   *
   * 与 `subagents` 是两套入口：这些没有对话可查看，只有「在跑什么 + 能不能中止」。
   * 空数组时整个入口不渲染（跑完就消失，不留空按钮）。
   */
  backgroundTasks?: BackgroundTaskEntry[];
  /** 中止一次后台操作；`taskId` 为空表示后端也查不到（按钮不给）。 */
  onStopTask?: (taskId: string) => void;
  title: string;
  busy: boolean;
  onToggleSidebar: () => void;
  onCopySession: () => Promise<boolean>;
  /** 导出这次会话的原始日志（zip）；返回是否成功。 */
  onDownloadSession: () => Promise<boolean>;
  rightOpen: boolean;
  onToggleRight: () => void;
  /** 「在飞牛打开工作区」按钮：只有宿主内且非 TCP 端口访问时才给 true。 */
  showReveal: boolean;
  onRevealWorkspace: () => void;
}


export function TopBar({ session, title, busy, subagents, onOpenSubagent, backgroundTasks = [], onStopTask, onToggleSidebar, onCopySession, onDownloadSession, rightOpen, onToggleRight, showReveal, onRevealWorkspace }: Props) {
  const t = useT();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const [taskAnchor, setTaskAnchor] = useState<HTMLElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [downloadState, setDownloadState] = useState<"idle" | "ok" | "fail">("idle");

  const copySession = async () => {
    if (!session) return;
    const ok = await onCopySession();
    setCopyState(ok ? "ok" : "fail");
    if (ok) window.setTimeout(() => setCopyState("idle"), 900);
  };

  const downloadSession = async () => {
    if (!session) return;
    const ok = await onDownloadSession();
    setDownloadState(ok ? "ok" : "fail");
    window.setTimeout(() => setDownloadState("idle"), ok ? 1200 : 2200);
  };
  return (
    <header className="safe-top shrink-0 border-b border-line bg-canvas md:pt-0">
      <div className="flex h-14 items-center gap-2 px-3 md:px-4">
        {/* 只有移动端的抽屉入口：桌面收起侧栏的开关在侧栏自己的品牌行里，
            页头再摆一颗同一个图标（两颗长得一样、位置又挨着标题）只会让人分不清。 */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink md:hidden"
          aria-label={t("打开侧栏", "Open sidebar")}
        >
          <IconPanel size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[14px] font-semibold text-ink">{session ? title : "Claude Code"}</h1>
            {busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
          </div>
        </div>

        {subagents.length > 0 && (
          <button
            type="button"
            onClick={(e) => setSubAnchor((prev) => (prev ? null : e.currentTarget))}
            className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t(`子智能体 ${subagents.length} 个`, `${subagents.length} subagents`)}
            aria-haspopup="menu"
            aria-expanded={subAnchor !== null}
            title={t("子智能体", "Subagents")}
          >
            <IconSpark size={15} />
            <span className="text-[11.5px] font-medium">{subagents.length}</span>
            {runningSubagents(subagents) > 0 && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
          </button>
        )}
        <Menu
          open={subAnchor !== null}
          anchor={subAnchor}
          items={subagents.map((sub) => ({
            id: sub.agentId,
            label: sub.label,
            icon: <span className={`h-1.5 w-1.5 rounded-full ${SUBAGENT_TONE[sub.status]}`} />,
            hint: sub.type,
            onSelect: () => onOpenSubagent(sub.agentId, sub.label),
          }))}
          onClose={() => setSubAnchor(null)}
          width={260}
          align="end"
        />

        {/* 后台操作：与「子智能体」分开的第二个入口。这里的都是**还在跑**的非子代理任务
            （后台命令 / MCP 调用），没有对话可查看，只能看它在做什么、中止它。
            列表空了整个按钮就不渲染——跑完即消失，不留一个空入口。 */}
        {backgroundTasks.length > 0 && (
          <button
            type="button"
            onClick={(e) => setTaskAnchor((prev) => (prev ? null : e.currentTarget))}
            className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-brand hover:bg-brand/10"
            aria-label={t(`后台操作 ${backgroundTasks.length} 个进行中`, `${backgroundTasks.length} background tasks running`)}
            aria-haspopup="menu"
            aria-expanded={taskAnchor !== null}
            title={t("后台操作", "Background tasks")}
          >
            <IconTerminal size={15} />
            <span className="text-[11.5px] font-medium">{backgroundTasks.length}</span>
          </button>
        )}
        <Menu
          open={taskAnchor !== null}
          anchor={taskAnchor}
          items={backgroundTasks.map((task) => ({
            id: task.taskId || task.toolUseId,
            label: task.label,
            icon: <span className="h-1.5 w-1.5 rounded-full bg-brand" />,
            hint: typeof task.progress === "number" ? `${task.progress}s` : undefined,
            // 行尾的中止按钮：不关闭菜单，可以连续停几个。拿不到 task_id 时不给——
            // 点了只会报错（后端表里也没有，说明这个任务已经不在 CLI 那里了）。
            // 图标用描边版：实心方块单摆在白底菜单里像一块常驻的高亮背景。
            // 中止要二次确认，确认按钮**就地**换在这一行（不另开弹窗）：这条命令
            // 可能正在写文件，误点的代价比多点一下大。
            ...(task.taskId && onStopTask
              ? {
                  trailing: {
                    label: t("中止", "Stop"),
                    confirmLabel: t("确认中止", "Confirm"),
                    icon: <IconStopOutline size={13} />,
                    onSelect: () => {
                      if (task.taskId) onStopTask(task.taskId);
                    },
                  },
                }
              : {}),
            onSelect: () => {
              /* 面板里的条目本身没有可打开的目标：后台命令没有转录。 */
            },
          }))}
          onClose={() => setTaskAnchor(null)}
          width={300}
          align="end"
        />

        {showReveal && (
          <button
            type="button"
            onClick={onRevealWorkspace}
            className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
            aria-label={t("在飞牛文件管理器中打开工作区", "Open workspace in Files")}
            title={t("在飞牛文件管理器中打开工作区", "Open workspace in Files")}
          >
            <IconFolder size={17} />
          </button>
        )}

        <button
          type="button"
          onClick={onToggleRight}
          className={`rounded-lg p-1.5 hover:bg-black/5 ${rightOpen ? "bg-panel-strong text-ink" : "text-muted hover:text-ink"}`}
          aria-label={rightOpen ? t("收起右侧栏", "Close right sidebar") : t("打开右侧栏", "Open right sidebar")}
          aria-pressed={rightOpen}
          title={rightOpen ? t("收起右侧栏", "Close right sidebar") : t("打开右侧栏", "Open right sidebar")}
        >
          <IconSidebarRight size={17} />
        </button>

        <button
          type="button"
          onClick={(e) => {
            setMenuAnchor(e.currentTarget);
            setCopyState("idle");
          }}
          className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label={t("更多", "More")}
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAnchor)}
          title={t("更多", "More")}
        >
          <IconMore size={17} />
        </button>
        <Menu
          open={Boolean(menuAnchor)}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          width={224}
          items={[
            {
              id: "copy",
              disabled: !session,
              icon: copyState === "ok" ? <IconCheck size={14} className="text-ok" /> : <IconCopy size={14} className="text-muted" />,
              label: !session
                ? t("没有可复制的会话", "No session to copy")
                : copyState === "ok"
                  ? t("已复制为 Markdown", "Copied as Markdown")
                  : copyState === "fail"
                    ? t("复制失败", "Copy failed")
                    : t("复制会话为 Markdown", "Copy session as Markdown"),
              onSelect: () => void copySession(),
            },
            {
              id: "download",
              icon: <IconDownload size={14} className="text-muted" />,
              label:
                downloadState === "ok"
                  ? t("已下载", "Downloaded")
                  : downloadState === "fail"
                    ? t("下载失败", "Download failed")
                    : t("下载 Session 日志", "Download session log"),
              disabled: !session,
              onSelect: () => void downloadSession(),
            },
          ]}
        />
      </div>
    </header>
  );
}
