import type { ReactNode } from "react";
import type { Item } from "../../lib/model";
import type { InitPayload, PublicSettings, SessionInfo } from "../../transport/types";
import type { ConnInfo, InfoResponse } from "../../store/useAppStore";
import { baseName, permissionLabel, stateLabel } from "../../lib/labels";
import { useLocale, useT } from "../../lib/i18n";
import { IconFolder, IconPlus, IconShield, IconSpark, IconTerminal } from "../common/Icons";

interface Props {
  session: SessionInfo | null;
  init: InitPayload | undefined;
  settings: PublicSettings | null;
  info: InfoResponse | null;
  conn: ConnInfo;
  mode: string;
  state: string;
  items: Item[];
  currentWorkspace: string;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export function OverviewPanel({ session, init, settings, info, conn, mode, state, items, currentWorkspace, onNewChat, onOpenSettings }: Props) {
  const t = useT();
  const locale = useLocale();
  const selected = settings?.selected;
  const spec = settings?.providers.find((p) => p.id === selected?.provider)?.model_meta?.[selected?.model ?? ""];
  const model = selected?.provider && selected?.model
    ? `${spec?.name || selected.model}${selected.effort ? ` · ${selected.effort}` : ""} · ${selected.provider}`
    : (session?.model ?? t("CLI 默认", "CLI default"));
  const tools = items.filter((i) => i.kind === "tool").length;
  const messages = items.filter((i) => i.kind === "user" || i.kind === "assistant").length;
  const cwd = session?.cwd || currentWorkspace;

  return (
    <div className="dsh-scroll h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[820px] px-4 py-6 md:px-6 md:py-8">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <IconSpark size={23} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold text-ink">{session ? baseName(session.cwd) : t("新对话", "New chat")}</h2>
            <p className="truncate font-mono text-[11px] text-muted">{cwd || t("尚未选择工作区", "No workspace selected")}</p>
          </div>
          <button
            type="button"
            onClick={onNewChat}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-panel-strong"
          >
            <IconPlus size={14} />
            {t("新对话", "New chat")}
          </button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Card icon={<IconFolder size={15} />} label={t("工作区", "Workspace")} value={cwd || t("未选择", "None")} mono />
          <Card icon={<IconTerminal size={15} />} label={t("会话状态", "Session")} value={session ? `${stateLabel(state, locale)} · ${conn.state === "open" ? t("WS 已连接", "WS connected") : t("WS 未连接", "WS disconnected")}` : t("未启动", "Not started")} />
          <Card icon={<IconSpark size={15} />} label={t("模型", "Model")} value={model} />
          <Card icon={<IconShield size={15} />} label={t("权限模式", "Permission")} value={permissionLabel(mode, locale)} />
          <Card icon={<IconTerminal size={15} />} label="CLI" value={`${init?.claude_code_version ?? info?.claude_version ?? t("未知", "Unknown")} · ${info?.claude_bin ?? ""}`} mono />
          <Card icon={<IconSpark size={15} />} label={t("本轮统计", "This turn")} value={t(`${messages} 条消息 · ${tools} 次工具调用`, `${messages} messages · ${tools} tool calls`)} />
        </div>

        <div className="mt-6">
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-panel-strong"
          >
            {t("打开设置", "Open settings")}
          </button>
        </div>

        {session && conn.reason && conn.state !== "open" && (
          <p className="mt-3 text-[11px] text-warn">{conn.reason}</p>
        )}
      </div>
    </div>
  );
}

function Card({ icon, label, value, mono }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-canvas p-3.5">
      <div className="flex items-center gap-1.5 text-[10.5px] text-faint">
        <span className="text-muted">{icon}</span>
        {label}
      </div>
      <p className={`mt-1.5 break-words text-[12.5px] text-ink ${mono ? "font-mono text-[11.5px]" : ""}`}>{value}</p>
    </div>
  );
}
