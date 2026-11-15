import { useEffect, useRef } from "react";
import type { Item } from "../../lib/model";
import { AssistantBubble } from "./AssistantBubble";
import { ResultBar } from "./ResultBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserBubble } from "./UserBubble";
import { ToolCardHost } from "../tools/ToolCardHost";
import { IconAlert, IconSpark } from "../common/Icons";

export function MessageList({ items, empty }: { items: Item[]; empty?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // 只在贴近底部时自动跟随，避免用户向上翻历史时被拽回。
  useEffect(() => {
    if (!stick.current) return;
    const el = scroller.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <IconSpark size={23} />
        </span>
        <p className="text-[15px] font-medium text-ink">{empty ?? "开始新的对话"}</p>
        <p className="max-w-sm text-[12px] leading-relaxed text-muted">
          在下方输入消息。Claude 会在当前工作区里读取文件、执行命令，并把每一步结构化展示出来。
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scroller}
      className="dsh-scroll h-full overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      }}
    >
      <div className="mx-auto w-full max-w-[820px] px-4 py-6 md:px-6 md:py-8">
        <div className="space-y-5 text-[14.5px]">
          {items.map((item) => {
            switch (item.kind) {
              case "user":
                return (
                  <div key={item.id} className="animate-rise">
                    <UserBubble text={item.text} ts={item.ts} />
                  </div>
                );
              case "assistant":
                return (
                  <div key={item.id} className="animate-rise">
                    <AssistantBubble text={item.text} streaming={item.streaming} ts={item.ts} />
                  </div>
                );
              case "thinking":
                return (
                  <div key={item.id} className="animate-rise">
                    <ThinkingBlock text={item.text} />
                  </div>
                );
              case "tool":
                return (
                  <div key={item.id} className="animate-rise">
                    <ToolCardHost item={item} />
                  </div>
                );
              case "result":
                return <ResultBar key={item.id} item={item} />;
              case "system":
                return (
                  <pre
                    key={item.id}
                    className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-relaxed text-muted"
                  >
                    {item.text}
                  </pre>
                );
              case "error":
                return (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30"
                  >
                    <IconAlert size={15} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
                  </div>
                );
              default:
                return null;
            }
          })}
        </div>
        <div className="h-6" />
      </div>
    </div>
  );
}
