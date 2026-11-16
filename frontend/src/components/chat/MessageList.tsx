import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Item } from "../../lib/model";
import { AssistantBubble } from "./AssistantBubble";
import { ResultBar } from "./ResultBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserBubble } from "./UserBubble";
import { ToolCardHost } from "../tools/ToolCardHost";
import { IconAlert, IconChevronDown, IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";

/**
 * 长对话只渲染最近这一批，往上翻时再按批展开。
 *
 * 为什么不是虚拟列表：消息高度差异极大（一行文字 vs 几百行 diff），
 * 自己算高度容易抖；「限制渲染条数 + 离屏跳过布局绘制」足够压住 DOM 规模，
 * 也不会破坏浏览器自带的查找、锚点与无障碍树。
 */
const VISIBLE_STEP = 80;
/** 离屏行不参与布局/绘制；估算高度给滚动条一个稳定长度。 */
const OFFSCREEN = { contentVisibility: "auto", containIntrinsicSize: "auto 120px" } as const;

/** 单条消息。memo 化：流式追加时只有最后一个气泡需要重渲染。 */
const MessageRow = memo(function MessageRow({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <UserBubble text={item.text} ts={item.ts} />
        </div>
      );
    case "assistant":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <AssistantBubble text={item.text} streaming={item.streaming} ts={item.ts} />
        </div>
      );
    case "thinking":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <ThinkingBlock text={item.text} />
        </div>
      );
    case "tool":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <ToolCardHost item={item} />
        </div>
      );
    case "result":
      return <ResultBar item={item} />;
    case "system":
      return (
        <pre
          style={OFFSCREEN}
          className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-relaxed text-muted"
        >
          {item.text}
        </pre>
      );
    case "error":
      return (
        <div
          style={OFFSCREEN}
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30"
        >
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
        </div>
      );
    default:
      return null;
  }
});

export function MessageList({
  items,
  empty,
  resetKey,
}: {
  items: Item[];
  empty?: string;
  /** 切换对话时用它把「已展开的批次」复位。 */
  resetKey?: string;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  /** 贴底跟随：用户往上翻就停下，回到底部再恢复。 */
  const stick = useRef(true);
  const [limit, setLimit] = useState(VISIBLE_STEP);
  const [atBottom, setAtBottom] = useState(true);
  /** 不贴底时来了新内容：按钮上点一个提示点。 */
  const [unseen, setUnseen] = useState(false);
  const prevCount = useRef(items.length);
  /** 展开更早消息前记录的「距底部距离」，用于展开后保持视口不动。 */
  const anchorFromBottom = useRef<number | null>(null);

  const hidden = Math.max(0, items.length - limit);
  const shown = hidden > 0 ? items.slice(-limit) : items;

  useEffect(() => {
    setLimit(VISIBLE_STEP);
    stick.current = true;
    setAtBottom(true);
    setUnseen(false);
    prevCount.current = items.length;
  }, [resetKey]);

  // 新内容到达：贴底就跟随；否则只点亮「有新内容」。
  useEffect(() => {
    const el = scroller.current;
    const grew = items.length > prevCount.current;
    prevCount.current = items.length;
    if (!el) return;
    if (stick.current) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      setAtBottom(true);
      setUnseen(false);
    } else if (grew) {
      setUnseen(true);
    }
  }, [items]);

  // 展开更早的消息后把视口钉在原来那条消息上，别让它「跳一下」。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || anchorFromBottom.current === null) return;
    el.scrollTop = el.scrollHeight - anchorFromBottom.current;
    anchorFromBottom.current = null;
  }, [limit]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    stick.current = near;
    setAtBottom(near);
    if (near) setUnseen(false);
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    setUnseen(false);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (!reduce && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };

  const loadEarlier = () => {
    const el = scroller.current;
    if (el) anchorFromBottom.current = el.scrollHeight - el.scrollTop;
    setLimit((n) => n + VISIBLE_STEP);
  };

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <IconSpark size={23} />
        </span>
        <p className="text-[15px] font-medium text-ink">{empty ?? t("开始新的对话", "Start a new conversation")}</p>
        <p className="max-w-sm text-[12px] leading-relaxed text-muted">
          {t("在下方输入消息。Claude 会在当前工作区里读取文件、执行命令，并把每一步结构化展示出来。", "Type below. Claude reads files, runs commands and renders each step structurally.")}
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div
        ref={scroller}
        data-testid="message-scroller"
        className="dsh-scroll h-full overflow-y-auto"
        onScroll={onScroll}
      >
        <div className="mx-auto w-full max-w-[820px] px-4 py-6 md:px-6 md:py-8">
          <div className="space-y-5">
            {hidden > 0 && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={loadEarlier}
                  className="rounded-full border border-line-strong bg-canvas px-3 py-1 text-[11.5px] text-muted transition hover:bg-panel-strong hover:text-ink"
                >
                  {t(`加载更早的 ${Math.min(VISIBLE_STEP, hidden)} 条`, `Load ${Math.min(VISIBLE_STEP, hidden)} earlier`)}
                </button>
              </div>
            )}
            {shown.map((item) => (
              <MessageRow key={item.id} item={item} />
            ))}
          </div>
          <div className="h-6" />
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={toBottom}
          aria-label={unseen ? t("有新内容，回到底部", "New messages — jump to bottom") : t("回到底部", "Scroll to bottom")}
          title={t("回到底部", "Scroll to bottom")}
          className="absolute bottom-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-line-strong bg-canvas/95 text-ink shadow-soft backdrop-blur transition hover:bg-panel-strong"
        >
          <IconChevronDown size={16} />
          {unseen && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand" />}
        </button>
      )}
    </div>
  );
}
