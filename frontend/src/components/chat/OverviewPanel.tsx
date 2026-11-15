import type { ReactNode } from "react";
import type { Item } from "../../lib/model";
import type { InitPayload, PublicSettings, SessionInfo } from "../../transport/types";
import type { ConnInfo, InfoResponse } from "../../store/useAppStore";
import { baseName, permissionLabel, stateLabel } from "../../lib/labels";
import { IconFolder, IconPlus, IconSettings, IconShield, IconSpark, IconTerminal } from "../common/Icons";

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
  const selected = settings?.selected;
  const model = selected?.provider && selected?.model ? `${selected.model} · ${selected.provider}` : (session?.model ?? "CLI 默认");
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
            <h2 className="truncate text-[17px] font-semibold text-ink">{session ? baseName(session.cwd) : "新对话"}</h2>
            <p className="truncate font-mono text-[11px] text-muted">{cwd || "尚未选择工作区"}</p>
          </div>
          <button
            type="button"
            onClick={onNewChat}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-panel-strong"
          >
            <IconPlus size={14} />
            新对话
          </button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Card icon={<IconFolder size={15} />} label="工作区" value={cwd || "未选择"} mono />
          <Card icon={<IconTerminal size={15} />} label="会话状态" value={session ? `${stateLabel(state)} · ${conn.state === "open" ? "WS 已连接" : "WS 未连接"}` : "未启动"} />
          <Card icon={<IconSpark size={15} />} label="模型" value={model} />
          <Card icon={<IconShield size={15} />} label="权限模式" value={permissionLabel(mode)} />
          <Card icon={<IconTerminal size={15} />} label="CLI" value={`${info?.claude_version ?? "未知"} · ${info?.claude_bin ?? ""}`} mono />
          <Card icon={<IconSpark size={15} />} label="本轮统计" value={`${messages} 条消息 · ${tools} 次工具调用`} />
        </div>

        <div className="mt-6 rounded-2xl border border-line bg-panel/50 p-4">
          <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
            <IconSettings size={15} className="text-muted" />
            运行环境
          </div>
          <dl className="mt-3 grid gap-2 text-[11px]">
            <Row k="数据目录" v={info?.data_dir} />
            <Row k="claude HOME" v={info?.claude_home} />
            <Row k="授权目录文件" v={info?.workspaces_file} />
            <Row k="版本" v={`${info?.version ?? "-"} · CLI ${init?.claude_code_version ?? info?.claude_version ?? "-"}`} />
            <Row k="自动启动" v={info?.auto_start ? "已开启" : "已关闭"} />
          </dl>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-[11.5px] font-medium text-ink hover:bg-panel-strong"
          >
            打开设置
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

function Row({ k, v }: { k: string; v?: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-faint">{k}</dt>
      <dd className="min-w-0 break-all font-mono text-muted">{v || "-"}</dd>
    </div>
  );
}
