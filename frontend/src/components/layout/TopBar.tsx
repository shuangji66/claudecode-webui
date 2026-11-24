import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { SessionInfo } from "../../transport/types";
import { useT } from "../../lib/i18n";
import { formatElapsed } from "../../lib/elapsed";
import { formatTokens } from "../../lib/usage";
import { subagentElapsed, subagentLastAction, subagentProgressLine, subagentTokensUsed, type SubagentEntry } from "../../lib/subagents";
import { useAppStore } from "../../store/useAppStore";
import type { BackgroundTaskEntry } from "../../lib/backgroundTasks";
import { Menu } from "../common/Menu";
import { StateDot, type StateDotState } from "../common/StateDot";
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

/**
 * 子代理状态 → 状态标记。
 *
 * 用 `StateDot` 而不是就地画一个彩色圆点：运行中是转圈（进行中的唯一视觉语言，
 * 与侧栏对话行、回合计时器同一套），完成是绿点、被中断是主题色点、失败是红点。
 * 一眼就能看出「还在跑 / 已经跑完了 / 被打断」，不再是一排同形的点靠颜色猜。
 */
const SUBAGENT_DOT: Record<SubagentEntry["status"], StateDotState> = {
  running: "ongoing",
  completed: "done",
  stopped: "brand",
  failed: "fail",
};

/**
 * 列表左侧那颗状态标记。
 *
 * 尺寸分开给：`StateDot` 的进度环画的是 SVG 外框，圆点只占外框的内 60%，
 * 同一个数值下环看着比点小一号，两者并排时高度差会顺着文字垂直对齐一起抖。
 */
function SubagentMark({ status }: { status: SubagentEntry["status"] }) {
  const state = SUBAGENT_DOT[status];
  return <StateDot state={state} size={state === "ongoing" ? 13 : 10} />;
}

/**
 * 「子代理此刻在做什么」的空结果。
 *
 * 必须是**模块级常量**：`useShallow` 按引用比较，每次 selector 现造一个 `{}` 的话，
 * 列表关着的时候每次 store 变更都会认为「变了」，白白把页头重画一遍。
 */
const EMPTY_ACTIONS: Record<string, string> = {};

/**
 * 菜单开着时每秒走一次的时钟。
 *
 * 运行时间必须自己走：后台命令与子代理都没有「每秒一帧」的保证（`task_progress` 只在
 * 真的有进度时报，两个工具调用之间可能几十秒什么都没有），靠事件驱动的秒数会停在最后
 * 一次上报上——看起来像卡住了。菜单一关就停，不留一个空转的 interval。
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // 用 layout effect 在**绘制前**先校准一次：菜单打开的第一帧如果拿着上次关闭时留下的
  // 时间戳去算，会先闪一下「0s / 一个偏小的秒数」，然后才跳到正确值。
  useLayoutEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * 子代理行右侧的指标：token 消耗 + 运行时间（拿不到的项不占位）。
 *
 * 用量**不带单位**：它是这一行右侧的指标，不是一句话；`47.2K tokens / 2:31` 在
 * 42% 的提示宽度里放不下，先把运行时间截掉（截图复现过「/ 2…」），而两个都是要看的数。
 * 两个数之间也**不留空格**（`47.2K/2:31`）：提示是 `shrink-0` 的，它宽出来的每一像素
 * 都是从左边那行「此刻在做什么」里扣的，而那一行才是要读的内容。
 */
function subagentHint(sub: SubagentEntry, now: number, liveTokens?: number): string | undefined {
  const parts: string[] = [];
  // **报累计消耗，不报 CLI 那个数**：`usage.totalTokens` 是「最后一次请求的上下文有多大」，
  // 一个大任务子代理能差 70 倍（实测 232K vs 16.4M），摆在这里会让人以为它没干活。
  // `liveTokens` 是转发帧算出的实时单次值，只在前者完全没有时当兜底。
  const tokens = subagentTokensUsed(sub.usage) ?? liveTokens;
  if (tokens !== undefined && tokens > 0) parts.push(formatTokens(tokens));
  const elapsed = subagentElapsed(sub, now);
  if (elapsed !== undefined) parts.push(formatElapsed(elapsed));
  return parts.length > 0 ? parts.join("/") : undefined;
}

/**
 * 后台操作行展开后的详情：运行时间、工具、命令与一行进度说明。
 *
 * 只展示我们**确实拿到了**的东西——后台命令没有逐行输出流（那份在 CLI 的输出文件里，
 * 要等结束通知才带回路径），这里不摆一个「实时输出」的空框。
 */
function backgroundDetail(
  task: BackgroundTaskEntry,
  now: number,
  t: (zh: string, en?: string) => string,
) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-faint">{t("已运行", "Elapsed")}</span>
        <span className="ml-auto font-mono">{formatElapsed(now - task.startedAt)}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-faint">{t("工具", "Tool")}</span>
        <span className="ml-auto truncate font-mono">{task.toolName}</span>
      </div>
      {task.progressNote && <p className="text-warn">{task.progressNote}</p>}
      {task.summary && <p>{task.summary}</p>}
      {task.command && (
        <div>
          <p className="mb-0.5 text-faint">{t("命令", "Command")}</p>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-[#0f1115] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-[#d9e0e8]">
            {task.command}
          </pre>
        </div>
      )}
    </div>
  );
}

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
  /** 后台操作里正在展开详情的那一行（默认全折叠；关菜单即复位）。 */
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [downloadState, setDownloadState] = useState<"idle" | "ok" | "fail">("idle");
  // 只有「列表正开着、里面真有时长在走」时才起时钟：不在屏幕上时不值得每秒重渲染一次页头。
  const now = useNow(
    (subAnchor !== null && subagents.length > 0) || (taskAnchor !== null && backgroundTasks.length > 0),
  );
  // 子代理的实时用量只在列表打开时订阅：关闭时返回 undefined（引用稳定，不触发重渲染），
  // 否则每一条子代理帧都会把整个页头重画一遍。
  const liveTokens = useAppStore((s) =>
    subAnchor !== null && session ? s.subagentTokens[session.id] : undefined,
  );
  /**
   * 子代理**此刻在做什么**：从它自己转发过来的消息流里取最后一次工具调用。
   *
   * 不订阅它的话，这一行只在 `task_progress` 到达时变，而那条帧的 `description`
   * 在 MCP / WebFetch 这类工具上恒等于派发任务时那句话（见
   * `lib/subagents.subagentProgressLine` 上面那段），列表会从派发之后一直定住到结束。
   * 只订阅自己那一条记录，并用 `useShallow` 按 agentId→字符串比较：内容没变就不重画。
   */
  const liveActions = useAppStore(
    useShallow((s) => {
      if (subAnchor === null || !session) return EMPTY_ACTIONS;
      const byAgent = s.subagentItems[session.id];
      if (!byAgent) return EMPTY_ACTIONS;
      const out: Record<string, string> = {};
      for (const [agentId, items] of Object.entries(byAgent)) {
        const action = subagentLastAction(items);
        if (action) out[agentId] = action;
      }
      return out;
    }),
  );

  // 复制/下载后的「已完成」提示要自己复位。句柄记在 ref 里，卸载时清掉：
  // 不清的话定时器会在组件已经卸载之后触发 setState（React 19 不再报错，但那次
  // 回调没有任何意义，而且连续点击还会攒下一串互不相关的复位）。
  const actionTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (actionTimer.current !== null) window.clearTimeout(actionTimer.current);
    };
  }, []);
  const resetLater = (fn: () => void, ms: number) => {
    if (actionTimer.current !== null) window.clearTimeout(actionTimer.current);
    actionTimer.current = window.setTimeout(() => {
      actionTimer.current = null;
      fn();
    }, ms);
  };

  const copySession = async () => {
    if (!session) return;
    const ok = await onCopySession();
    setCopyState(ok ? "ok" : "fail");
    resetLater(() => setCopyState("idle"), 900);
  };

  const downloadSession = async () => {
    if (!session) return;
    const ok = await onDownloadSession();
    setDownloadState(ok ? "ok" : "fail");
    resetLater(() => setDownloadState("idle"), ok ? 1200 : 2200);
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
          </button>
        )}
        <Menu
          open={subAnchor !== null}
          anchor={subAnchor}
          items={subagents.map((sub) => ({
            id: sub.agentId,
            label: sub.label,
            // 类型与「此刻在做什么」放第二行（DSH 的 subagent 列表同样是「标题 + 次要信息
            // + 指标」两行）：token 与运行时间要占住右侧那一列。
            //
            // 进度文字在这里是**唯一会变的行**：运行中它随每次工具调用刷新——但**不能
            // 只靠 CLI 的 `task_progress.description`**：MCP / WebFetch 这类工具没有活动
            // 描述解析器，那条帧每次都回落到派发任务时那句话，于是列表从派发之后就定住
            // 到结束（截图复现过）。第三参 `liveActions` 是子代理自己转发过来的最后一次
            // 工具调用，兜住这一档（见 `subagentProgressLine`）。
            // 跑完就没有进度可说了——那时类型才是更有用的信息。
            meta:
              (sub.status === "running"
                ? subagentProgressLine(sub, liveActions[sub.agentId])
                : undefined) ?? sub.type,
            icon: <SubagentMark status={sub.status} />,
            hint: subagentHint(sub, now, liveTokens?.[sub.agentId]),
            onSelect: () => onOpenSubagent(sub.agentId, sub.label),
          }))}
          onClose={() => setSubAnchor(null)}
          // 360 而不是 300：这一行是「标题 / 进度 + 右侧指标」两行结构，右侧那列
          // （hint）是 shrink-0 的、固定扣掉一段宽度，剩下的才给第二行那句「此刻在做什么」
          // ——而它常常是 `mcp__ccweb-web__web_fetch · …` 这种最需要看全的长串。
          // 300 时那行几乎只剩工具名前缀（手机上尤其明显）。手机上仍由定位层按视口收窄。
          width={360}
          align="end"
        />

        {/* 后台操作：与「子智能体」分开的第二个入口。这里的都是**还在跑**的非子代理任务
            （后台命令 / MCP 调用），没有对话可查看，只能看它在做什么、中止它。
            列表空了整个按钮就不渲染——跑完即消失，不留一个空入口。 */}
        {backgroundTasks.length > 0 && (
          <button
            type="button"
            onClick={(e) => {
              // 每次开合都从全折叠开始：上一次展开的那行不该自己又弹开。
              setExpandedTask(null);
              setTaskAnchor((prev) => (prev ? null : e.currentTarget));
            }}
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
          items={backgroundTasks.map((task) => {
            const id = task.taskId || task.toolUseId;
            return {
              id,
              label: task.label,
              icon: <span className="h-1.5 w-1.5 rounded-full bg-brand" />,
              // 运行时间在行尾一直走（每秒），点开详情里还有一份带「已运行」标签的。
              hint: formatElapsed(now - task.startedAt),
              // 点一行**就地展开**详情，不关菜单：这是「看一眼它在跑什么」的动作，
              // 关掉菜单再点开就看不到刚才那条了。
              keepOpen: true,
              expanded: expandedTask === id,
              detail: backgroundDetail(task, now, t),
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
              onSelect: () => setExpandedTask((cur) => (cur === id ? null : id)),
            };
          })}
          onClose={() => {
            setTaskAnchor(null);
            // 展开态只在这一次菜单里成立：重新打开时默认全折叠。
            setExpandedTask(null);
          }}
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
