import type { ReactNode } from "react";
import type { SessionInfo } from "../../transport/types";
import type { ConnInfo } from "../../store/useAppStore";
import { clockTime, permissionLabel } from "../../lib/labels";
import { IconFolder, IconMore, IconPanel } from "../common/Icons";

export type ChatTab = "chat" | "overview";

interface Props {
  session: SessionInfo | null;
  title: string;
  conn: ConnInfo;
  busy: boolean;
  tab: ChatTab;
  mode: string;
  onTab: (tab: ChatTab) => void;
  onToggleSidebar: () => void;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
}

const CONN_TEXT: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "已连接",
  reconnecting: "重连中",
  closed: "已断开",
};

const CONN_DOT: Record<string, string> = {
  idle: "bg-faint",
  connecting: "bg-warn",
  open: "bg-ok",
  reconnecting: "bg-warn",
  closed: "bg-danger",
};

export function TopBar({ session, title, conn, busy, tab, mode, onTab, onToggleSidebar, onToggleCollapse, onOpenSettings }: Props) {
  const connText = CONN_TEXT[conn.state] ?? "未连接";

  return (
    <header className="safe-top shrink-0 border-b border-line bg-canvas md:pt-0">
      <div className="flex h-[56px] items-center gap-2 px-3 md:px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink md:hidden"
          aria-label="打开侧栏"
        >
          <IconPanel size={18} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink md:inline-flex"
          aria-label="收起侧栏"
          title="收起侧栏"
        >
          <IconPanel size={17} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[14px] font-semibold text-ink">{session ? title : "新对话"}</h1>
            <span className="hidden shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              {permissionLabel(mode)}
            </span>
            {busy && <span className="thinking-dot h-1.5 w-1.5 shrink-0 rounded-full bg-brand sm:hidden" />}
          </div>
          <div className="flex min-w-0 items-center gap-1 text-[10.5px] text-faint">
            <IconFolder size={11} className="shrink-0" />
            <span className="truncate font-mono" title={session?.cwd}>
              {session?.cwd ?? "选择工作区开始"}
            </span>
            {session?.last_active && <span className="hidden shrink-0 sm:inline">· {clockTime(Date.parse(session.last_active))}</span>}
          </div>
        </div>

        <span className="hidden items-center gap-1.5 text-[11px] text-muted sm:flex" title={conn.reason}>
          <span className={`h-1.5 w-1.5 rounded-full ${CONN_DOT[conn.state] ?? "bg-faint"}`} />
          {connText}
        </span>
        <span className={`h-1.5 w-1.5 rounded-full sm:hidden ${CONN_DOT[conn.state] ?? "bg-faint"}`} title={connText} />

        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
          aria-label="设置"
          title="设置"
        >
          <IconMore size={17} />
        </button>
      </div>

      <div className="flex h-[38px] items-end gap-1 px-3 md:px-4">
        <TabButton active={tab === "chat"} onClick={() => onTab("chat")}>
          对话
        </TabButton>
        <TabButton active={tab === "overview"} onClick={() => onTab("overview")}>
          概览
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
