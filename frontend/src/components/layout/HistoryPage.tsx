import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { ConversationInfo } from "../../transport/types";
import { relativeTime } from "../../lib/labels";
import { ARCHIVED_NOTICE_EN, ARCHIVED_NOTICE_ZH, sortByRecent } from "../../lib/conversations";
import { authorizeFnosDir } from "../../lib/fnos";
import { useLocale, useT } from "../../lib/i18n";
import { PageShell } from "./FeaturePage";
import { Menu, type MenuItem } from "../common/Menu";
import { askConfirm } from "../common/SystemDialogs";
import { IconArchive, IconFolder, IconSearch, IconTrash } from "../common/Icons";

interface Props {
  /** 回到对话（整页视图没有遮罩，关闭就是回对话区）。 */
  onClose: () => void;
  /** 移动端抽屉入口：整页视图会把对话区的页头一起盖掉。 */
  onOpenSidebar?: () => void;
}

/**
 * 历史记录（侧栏功能区的一整页视图）：读 ~/.claude/projects 下各会话的 jsonl 摘要。
 *
 * 点击条目会用 claude 的 --resume 恢复同一个对话 id，并回放转录；
 * 不再像旧版本那样「切目录开新会话」。
 */
export function HistoryPage({ onClose, onOpenSidebar }: Props) {
  const t = useT();
  const locale = useLocale();
  const conversations = useAppStore((s) => s.conversations);
  const workspaces = useAppStore((s) => s.workspaces);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const probeDir = useAppStore((s) => s.probeDir);
  const refreshConversations = useAppStore((s) => s.refreshConversations);
  const openConversation = useAppStore((s) => s.openConversation);
  const showToast = useAppStore((s) => s.showToast);
  const archiveConversation = useAppStore((s) => s.archiveConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const [query, setQuery] = useState("");
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 右键菜单：锚在这一行上，选项与右侧那两颗固定按钮一致。 */
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  // 每次进入这一页都现查一次：页面是挂载即进来、离开即卸载，天然没有「关掉再打开」的残留。
  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortByRecent(
      conversations.filter((c) => !q || (c.title || "").toLowerCase().includes(q) || c.cwd.toLowerCase().includes(q)),
    );
  }, [conversations, query]);

  const titleOf = (c: ConversationInfo) => c.title || t("新对话", "New chat");

  const archiveLabel = (c: ConversationInfo) => (c.archived ? t("取消归档", "Unarchive") : t("归档", "Archive"));

  /** 删除是软删除（转录保留），但会结束进程——先问一句。 */
  const askDelete = async (c: ConversationInfo) => {
    const ok = await askConfirm({
      title: t("删除对话", "Delete conversation"),
      message: t(
        `「${titleOf(c)}」会从列表移除并结束运行中的进程，转录文件仍保留。`,
        `"${titleOf(c)}" is removed from the list and any running process is stopped; the transcript file is kept.`,
      ),
      danger: true,
      confirmText: t("删除", "Delete"),
    });
    if (ok) void deleteConversation(c.id);
  };

  const openHistory = async (id: string, cwd: string) => {
    if (busyCwd) return;
    // 已归档的对话不能进入（对齐 DSH）：这一页本来就会列出归档项（筛选「全部 / 仅已归档」），
    // 点进去等于把刚归档的那条又拉回对话区。要打开得先取消归档 —— 行尾那颗图章按钮。
    if (conversations.find((c) => c.id === id)?.archived) {
      showToast(t(ARCHIVED_NOTICE_ZH, ARCHIVED_NOTICE_EN));
      return;
    }
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
      // 转录与 claude 拉起是并行的（历史是磁盘上的 jsonl，跟子进程无关）：
      // 历史一上屏就把这一页收掉，让用户在对话区看历史，子进程在后台继续握手。
      // 起不来由对话区的错误条报，不必把用户扣在列表上等。
      const ok = await openConversation(id, false, onClose);
      if (ok) onClose();
    } finally {
      setBusyCwd(null);
    }
  };

  const menuConv = menu ? conversations.find((c) => c.id === menu.id) : undefined;

  return (
    <PageShell
      title={t("历史记录", "History")}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-line px-4 py-2.5 md:px-6">
        <div className="flex items-center gap-2 rounded-[10px] border border-line-strong px-2.5 py-1.5 focus-within:border-brand/60">
          <IconSearch size={14} className="text-muted" />
          {/* 不要 autoFocus：手机上打开历史记录会直接弹出键盘，把大半个列表顶走。 */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("搜索历史会话", "Search history")}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
          />
        </div>
        {/* 提示行兼作反馈行：切换/报错时替换掉说明文字，不额外占一条底部栏。
            底部不再有「共 N 条对话」和「关闭」——右上角 × 与 Esc/遮罩都能关。 */}
        <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
          {err
            ? <span className="text-danger">{err}</span>
            : busyCwd
              ? t(`正在切换到 ${busyCwd}…`, `Switching to ${busyCwd}…`)
              : t("点击条目会恢复该对话并回放转录内容；未授权的目录会自动添加授权。", "Clicking an entry resumes the conversation and replays its transcript. Unauthorized directories are added automatically.")}
        </p>
      </div>

      {/* 底部没有 footer 了，安全区留白挪到这里：滚动区最后一行的下沿不能让
          iPhone 的 Home Indicator 压住。 */}
      <div className="dsh-scroll min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] md:px-4">
        {rows.length === 0 && <p className="px-3 py-8 text-center text-[12px] text-muted">{t("没有匹配的历史会话。", "No matching sessions.")}</p>}
        {rows.map((c) => (
          <div
            key={c.id}
            // 行本身不再是 <button>：右侧两颗操作按钮嵌不进去（button 不能嵌套）。
            // 路径仍留在 title 里，悬浮可见，但不再占一行（一堆 /vol1/… 只是噪音）。
            className="side-row items-start"
            title={c.cwd}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (busyCwd) return;
              setMenu({ id: c.id, anchor: e.currentTarget });
            }}
          >
            <button
              type="button"
              disabled={Boolean(busyCwd)}
              onClick={() => void openHistory(c.id, c.cwd)}
              className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:opacity-50"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-panel-strong text-muted">
                <IconFolder size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink">{titleOf(c)}</span>
                <span className="mt-0.5 block truncate text-[10px] text-faint">
                  {relativeTime(c.last_active, Date.now(), locale)}
                  {" · "}
                  {/* 归档状态原本占右栏一行，现在并进这条元信息里，给操作按钮让位。 */}
                  {c.archived ? t("已归档", "Archived") : t(`${c.messages} 条`, `${c.messages} msgs`)}
                </span>
              </span>
            </button>
            {/* 固定按钮（不靠悬停）：触屏没有 hover，历史记录在手机上用得最多。 */}
            <span className="ml-1 flex shrink-0 items-center gap-1 self-center">
              <button
                type="button"
                disabled={Boolean(busyCwd)}
                onClick={() => void archiveConversation(c.id, !c.archived)}
                // 已归档的行这颗按钮是「取消归档」：用主题色，与灰色的「归档」区分开，
                // 否则同一颗图标两种语义只能靠 tooltip 分辨。
                className={`rounded-md p-1.5 transition disabled:opacity-50 ${
                  c.archived ? "text-brand hover:bg-brand/10" : "text-muted hover:bg-black/5 hover:text-ink"
                }`}
                aria-label={`${archiveLabel(c)} ${titleOf(c)}`}
                title={archiveLabel(c)}
              >
                <IconArchive size={15} />
              </button>
              <button
                type="button"
                disabled={Boolean(busyCwd)}
                onClick={() => void askDelete(c)}
                className="rounded-md p-1.5 text-muted transition hover:bg-black/5 hover:text-danger disabled:opacity-50"
                aria-label={`${t("删除", "Delete")} ${titleOf(c)}`}
                title={t("删除", "Delete")}
              >
                <IconTrash size={15} />
              </button>
            </span>
          </div>
        ))}
      </div>

      {/* 右键等同于点行内那两颗按钮：统一的 Menu 原语，不在组件里另写一套监听。 */}
      <Menu
        open={Boolean(menuConv)}
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        width={168}
        items={
          menuConv
            ? ([
                {
                  id: "archive",
                  label: archiveLabel(menuConv),
                  icon: <IconArchive size={13} className={menuConv.archived ? "text-brand" : "text-muted"} />,
                  onSelect: () => void archiveConversation(menuConv.id, !menuConv.archived),
                },
                {
                  id: "delete",
                  label: t("删除", "Delete"),
                  icon: <IconTrash size={13} />,
                  danger: true,
                  onSelect: () => void askDelete(menuConv),
                },
              ] satisfies MenuItem[])
            : []
        }
      />
    </PageShell>
  );
}
