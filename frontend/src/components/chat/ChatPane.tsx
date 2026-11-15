import { useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { TopBar } from "../layout/TopBar";
import { PermissionPanel } from "../permission/PermissionPanel";
import type { PermissionPayload } from "../../transport/types";

export function ChatPane({ onToggleSidebar, onOpenSettings }: { onToggleSidebar: () => void; onOpenSettings: () => void }) {
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);
  const items = useAppStore((s) => s.items);
  const perms = useAppStore((s) => s.perms);
  const inits = useAppStore((s) => s.inits);
  const states = useAppStore((s) => s.states);
  const conns = useAppStore((s) => s.conns);
  const settings = useAppStore((s) => s.settings);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const interrupt = useAppStore((s) => s.interrupt);
  const selectModel = useAppStore((s) => s.selectModel);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  const replyPermission = useAppStore((s) => s.replyPermission);

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const session = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const init = activeId ? inits[activeId] : undefined;
  const conn = activeId ? (conns[activeId] ?? "idle") : "idle";
  const state = activeId ? (states[activeId] ?? session?.state ?? "idle") : "idle";
  const busy = state === "busy";

  const pending = useMemo(
    () => (activeId ? (perms[activeId] ?? []).filter((p) => !dismissed.has(p.request_id)) : []),
    [perms, activeId, dismissed],
  );

  const handleReply = (
    perm: PermissionPayload,
    opts: { allow: boolean; updatedInput?: unknown; updatedPermissions?: unknown; message?: string },
  ) => {
    // 切模式类建议需要额外发一条 set_permission_mode，才能真正改变后续行为。
    if (opts.allow && opts.updatedPermissions && (opts.updatedPermissions as { type?: string }).type === "setMode") {
      const mode = (opts.updatedPermissions as { mode?: string }).mode;
      if (mode) setPermissionMode(mode);
    }
    replyPermission(perm, opts.allow, opts.updatedInput, opts.updatedPermissions, opts.message);
    setDismissed((prev) => new Set(prev).add(perm.request_id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        session={session}
        init={init}
        settings={settings}
        conn={conn}
        busy={busy}
        onInterrupt={interrupt}
        onPermissionMode={setPermissionMode}
        onSelectModel={(provider, model) => void selectModel(provider, model)}
        onToggleSidebar={onToggleSidebar}
        onOpenSettings={onOpenSettings}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeId ? (
          <MessageList items={items[activeId] ?? []} empty="还没有消息，发一条试试。" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
            <p>还没有正在运行的会话</p>
            <p className="text-xs">从左侧选择一个项目新建会话</p>
          </div>
        )}
      </div>

      {pending.map((p) => (
        <div key={p.request_id} className="px-3 pt-2">
          <PermissionPanel perm={p} onReply={(opts) => handleReply(p, opts)} />
        </div>
      ))}

      <Composer
        disabled={!activeId || conn !== "open"}
        commands={init?.commands ?? []}
        onSend={sendPrompt}
        onInterrupt={interrupt}
        busy={busy}
      />
    </div>
  );
}
