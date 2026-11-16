import { createPortal } from "react-dom";
import { PORTAL_ATTR } from "../common/Menu";
import { useLocale, useT } from "../../lib/i18n";
import { relativeTime } from "../../lib/labels";
import type { ConversationInfo, HistoryPreview } from "../../transport/types";

const WIDTH = 320;
const HEIGHT_ESTIMATE = 240;

/**
 * 侧栏会话的悬浮预览：标题 + 工作区/时间/条数 + 最近一问一答。
 *
 * 参照 DSH：鼠标悬停 200ms 左右弹出，放在行的右侧（右侧放不下就贴住视口）。
 * 触屏没有 hover，不显示。卡片 `pointer-events-none`，不会挡住点击。
 */
export function ConversationPreview({
  anchor,
  conv,
  title,
  workspace,
  preview,
  loading,
}: {
  anchor: HTMLElement;
  conv: ConversationInfo;
  title: string;
  workspace: string;
  preview: HistoryPreview | null;
  loading: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right + 10, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - HEIGHT_ESTIMATE - 8));

  return createPortal(
    <div
      role="tooltip"
      {...{ [PORTAL_ATTR]: "" }}
      style={{ left, top, width: WIDTH }}
      className="pointer-events-none fixed z-[70] rounded-xl border border-line bg-canvas p-3 shadow-soft"
    >
      <p className="truncate text-[12.5px] font-medium text-ink">{title}</p>
      <p className="mt-0.5 truncate text-[10.5px] text-faint">
        {[workspace, relativeTime(conv.last_active, Date.now(), locale), t(`${conv.messages} 条消息`, `${conv.messages} messages`)]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {loading ? (
        <p className="mt-2 text-[11px] text-faint">{t("正在加载…", "Loading…")}</p>
      ) : preview?.user || preview?.assistant ? (
        <>
          {preview.user && (
            <p className="mt-2 line-clamp-2 border-l-2 border-line pl-2 text-[11.5px] leading-relaxed text-ink-2">
              {preview.user}
            </p>
          )}
          {preview.assistant && (
            <p className="mt-1.5 line-clamp-3 text-[11.5px] leading-relaxed text-muted">{preview.assistant}</p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[11px] text-faint">{t("还没有内容", "No content yet")}</p>
      )}
    </div>,
    document.body,
  );
}
