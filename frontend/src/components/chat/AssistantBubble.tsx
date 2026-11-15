import { Markdown } from "../common/Markdown";

export function AssistantBubble({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2 text-slate-800 dark:bg-slate-800 dark:text-slate-100">
        <Markdown text={text} />
        {streaming && <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-slate-400 align-middle" />}
      </div>
    </div>
  );
}
