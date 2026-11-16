import { useState, type ReactNode } from "react";
import type { SessionInfo } from "../../transport/types";
import { permissionLabel } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import { Menu } from "../common/Menu";
import { IconCheck, IconCopy, IconMore, IconPanel, IconSettings, IconSidebarRight } from "../common/Icons";

export type ChatTab = "chat" | "overview";

interface Props {
  session: SessionInfo | null;
  title: string;
  busy: boolean;
  tab: ChatTab;
  mode: string;
  onTab: (tab: ChatTab) => void;
  onToggleSidebar: () => void;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onCopySession: () => Promise<boolean>;
  rightOpen: boolean;
  onToggleRight: () => void;
}


export function TopBar({ session, title, busy, tab, mode, onTab, onToggleSidebar, onToggleCollapse, onOpenSettings, onCopySession, rightOpen, onToggleRight }: Props) {
  const t = useT();
  const locale = useLocale();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  const copySession = async () => {
    if (!session) return;
    const ok = await onCopySession();
    setCopyState(ok ? "ok" : "fail");
    if (ok) window.setTimeout(() => setCopyState("idle"), 900);
  };
  return (
    <header className="safe-top shrink-0 border-b border-line bg-canvas md:pt-0">
      <div className="flex h-[56px] items-center gap-2 px-3 md:px-4">
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
            <span className="hidden shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              {permissionLabel(mode, locale)}
            </span>
            {busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand sm:hidden" />}
          </div>
        </div>

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

      <div className="flex h-[38px] items-end gap-1 px-3 md:px-4">
        <TabButton active={tab === "chat"} onClick={() => onTab("chat")}>
          {t("对话", "Chat")}
        </TabButton>
        <TabButton active={tab === "overview"} onClick={() => onTab("overview")}>
          {t("概览", "Overview")}
        </TabButton>
      </div>
    </header>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-1.5 pb-2 text-[12.5px] transition ${
        active ? "font-medium text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
      {active && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-brand" />}
    </button>
  );
}
