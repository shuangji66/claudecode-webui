import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { relativeTime } from "../../lib/labels";
import { authorizeFnosDir } from "../../lib/fnos";
import { useLocale, useT } from "../../lib/i18n";
import { Button } from "../common/Button";
import { Dialog } from "../common/Dialog";
import { IconFolder, IconHistory, IconSearch } from "../common/Icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 历史记录：读 ~/.claude/projects 下各会话的 jsonl 摘要。
 *
 * 点击条目会用 claude 的 --resume 恢复同一个对话 id，并回放转录；
 * 不再像旧版本那样「切目录开新会话」。
 */
export function HistoryDialog({ open, onClose }: Props) {
  const t = useT();
  const locale = useLocale();
  const conversations = useAppStore((s) => s.conversations);
  const workspaces = useAppStore((s) => s.workspaces);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const probeDir = useAppStore((s) => s.probeDir);
  const refreshConversations = useAppStore((s) => s.refreshConversations);
  const openConversation = useAppStore((s) => s.openConversation);
  const [query, setQuery] = useState("");
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    void refreshConversations();
  }, [open, refreshConversations]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter((c) => !q || (c.title || "").toLowerCase().includes(q) || c.cwd.toLowerCase().includes(q))
      .sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""));
  }, [conversations, query]);

  if (!open) return null;

  const openHistory = async (id: string, cwd: string) => {
    if (busyCwd) return;
    setBusyCwd(cwd);
    setErr(null);
    try {
      const exact = workspaces.some((w) => w.path === cwd);
      const inside = workspaces.some((w) => cwd.startsWith(`${w.path}/`));
      if (!exact && !inside) {
        // 不能直接登记：应用以独立用户运行，能浏览不等于能读写。与「添加授权目录」
        // 同一条路——先探测应用用户能否直接写，写不进去才走飞牛授权；用户取消或
        // 宿主报错就不登记（否则 claude 起来后每一步都被拒）。
        let writable = false;
        try {
          writable = (await probeDir(cwd)).writable;
        } catch {
          writable = false;
        }
        if (!writable) {
          // skipped = 拿不到宿主（直连端口 / make dev），与「添加授权目录」一样降级放行；
          // denied = 用户取消或宿主报错，不能登记。
          const res = await authorizeFnosDir(cwd);
          if (res.state === "denied") {
            setErr(
              res.reason === "cancel"
                ? t("已取消目录授权，无法打开该对话", "Authorization cancelled; cannot open this conversation")
                : t(`目录授权失败：${res.reason === "message" ? res.message : "未知原因"}`, "Folder authorization failed"),
            );
            return;
          }
        }
        const ok = await addWorkspace(cwd, false);
        if (!ok) return;
      }
      await refreshConversations();
      const ok = await openConversation(id);
      if (ok) onClose();
    } finally {
      setBusyCwd(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("历史记录", "History")}
      title={t("历史记录", "History")}
      icon={<IconHistory size={17} />}
      sheet
      bodyScroll={false}
      bodyClassName="flex min-h-0 flex-1 flex-col"
      footer={
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] text-faint">
            {err
              ? <span className="text-danger">{err}</span>
              : busyCwd
                ? t(`正在切换到 ${busyCwd}…`, `Switching to ${busyCwd}…`)
                : t(`共 ${conversations.length} 条对话`, `${conversations.length} conversations`)}
          </p>
          <Button variant="secondary" onClick={onClose}>
            {t("关闭", "Close")}
          </Button>
        </div>
      }
    >
      <div className="border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-[10px] border border-line-strong px-2.5 py-1.5 focus-within:border-brand/60">
            <IconSearch size={14} className="text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("搜索历史会话", "Search history")}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
            {t("点击条目会恢复该对话并回放转录内容；未授权的目录会自动添加授权。", "Clicking an entry resumes the conversation and replays its transcript. Unauthorized directories are added automatically.")}
          </p>
        </div>

        <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {rows.length === 0 && <p className="px-3 py-8 text-center text-[12px] text-muted">{t("没有匹配的历史会话。", "No matching sessions.")}</p>}
          {rows.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={Boolean(busyCwd)}
              onClick={() => void openHistory(c.id, c.cwd)}
              className="side-row items-start text-left disabled:opacity-50"
              title={c.cwd}
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-panel-strong text-muted">
                <IconFolder size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink">{c.title || t("新对话", "New chat")}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-faint">{c.cwd}</span>
              </span>
              <span className="ml-2 shrink-0 text-right text-[10px] text-faint">
                <span className="block">{relativeTime(c.last_active, Date.now(), locale)}</span>
                <span className="block">{c.archived ? t("已归档", "Archived") : t(`${c.messages} 条`, `${c.messages} msgs`)}</span>
              </span>
            </button>
          ))}
        </div>

    </Dialog>
  );
}
