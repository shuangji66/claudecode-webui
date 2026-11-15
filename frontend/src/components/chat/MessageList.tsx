import { useEffect, useRef } from "react";
import type { Item } from "../../lib/model";
import { AssistantBubble } from "./AssistantBubble";
import { ResultBar } from "./ResultBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserBubble } from "./UserBubble";
import { ToolCardHost } from "../tools/ToolCardHost";

export function MessageList({ items, empty }: { items: Item[]; empty: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 只在贴近底部时自动跟随，避免用户向上翻历史时被拽回。
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  if (items.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">{empty}</div>;
  }

  return (
    <div
      className="space-y-3 overflow-y-auto px-3 py-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={item.id} text={item.text} />;
          case "assistant":
            return <AssistantBubble key={item.id} text={item.text} streaming={item.streaming} />;
          case "thinking":
            return <ThinkingBlock key={item.id} text={item.text} />;
          case "tool":
            return <ToolCardHost key={item.id} item={item} />;
          case "result":
            return <ResultBar key={item.id} item={item} />;
          case "system":
            return (
              <pre key={item.id} className="overflow-x-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500 dark:bg-slate-800">
                {item.text}
              </pre>
            );
          case "error":
            return (
              <div key={item.id} className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                {item.text}
              </div>
            );
          default:
            return null;
        }
      })}
      <div ref={bottomRef} />
    </div>
  );
}
