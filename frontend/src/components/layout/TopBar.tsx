import { useState } from "react";
import type { SessionInfo } from "../../transport/types";
import { useT } from "../../lib/i18n";
import { runningSubagents, type SubagentEntry } from "../../lib/subagents";
import { Menu } from "../common/Menu";
import { IconCheck, IconCopy, IconMore, IconPanel, IconSettings, IconSidebarRight, IconSpark } from "../common/Icons";

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
  title: string;
  busy: boolean;
  onToggleSidebar: () => void;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onCopySession: () => Promise<boolean>;
  rightOpen: boolean;
  onToggleRight: () => void;
}


export function TopBar({ session, title, busy, subagents, onOpenSubagent, onToggleSidebar, onToggleCollapse, onOpenSettings, onCopySession, rightOpen, onToggleRight }: Props) {
  const t = useT();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  const copySession = async () => {
    if (!session) return;
    const ok = await onCopySession();
    setCopyState(ok ? "ok" : "fail");
    if (ok) window.setTimeout(() => setCopyState("idle"), 900);
  };
  return (
    <header className="safe-top shrink-0 border-b border-line bg-canvas md:pt-0">
      <div className="flex h-14 items-center gap-2 px-3 md:px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink md:hidden"
          aria-label={t("打开侧栏", "Open sidebar")}
        >
          <IconPanel size={18} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink md:inline-flex"
          aria-label={t("收起侧栏", "Collapse sidebar")}
          title={t("收起侧栏", "Collapse sidebar")}
        >
          <IconPanel size={17} />
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
              id: "settings",
              icon: <IconSettings size={14} className="text-muted" />,
              label: t("设置", "Settings"),
              onSelect: onOpenSettings,
            },
          ]}
        />
      </div>
    </header>
  );
}
