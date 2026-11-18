import { StateDot } from "../common/StateDot";
import type { ConversationStatus } from "../../lib/conversations";
import { useLocale, useT } from "../../lib/i18n";
import { conversationStatusLabel, relativeTime } from "../../lib/labels";
import type { ConversationInfo } from "../../transport/types";
import { HoverPreview } from "./HoverPreview";

/**
 * 侧栏会话的悬浮概览：标题 + 完整路径 + 时间/条数 + 状态。
 *
 * 参照 DSH：只回答「这是哪条对话、在哪、什么状态」，**不再显示最近一问一答**——
 * 正文摘要在列表上滑一下就能看出个大概，塞进卡片反而让概览变重、还多打一次接口。
 *
 * 状态（空闲 / 运行中 / 待审批 / 已完成 / 未运行）直接写进卡片里，行上因此不再挂
 * 原生 `title`——否则浏览器提示会和卡片各报一份，两张浮层叠在一起。
 */
export function ConversationPreview({
  anchor,
  conv,
  title,
  path,
  status,
}: {
  anchor: HTMLElement;
  conv: ConversationInfo;
  title: string;
  /** 会话 cwd（完整路径）。 */
  path: string;
  status: ConversationStatus;
}) {
  const t = useT();
  const locale = useLocale();
  const dot = status === "approval" || status === "ongoing" || status === "done" ? status : "off";
  const meta = [relativeTime(conv.last_active, Date.now(), locale), t(`${conv.messages} 条消息`, `${conv.messages} messages`)]
    .filter(Boolean)
    .join(" · ");

  return (
    <HoverPreview anchor={anchor}>
      <p className="truncate text-[12.5px] font-medium text-ink">{title}</p>
      <p className="mt-0.5 truncate text-[10.5px] text-faint" title={path}>
        {path}
      </p>
      <p className="mt-0.5 truncate text-[10.5px] text-faint">{meta}</p>
      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
        <StateDot state={dot} size={9} />
        <span>{conversationStatusLabel(status, locale)}</span>
      </p>
    </HoverPreview>
  );
}
