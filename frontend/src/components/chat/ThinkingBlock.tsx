import { Collapsible } from "../common/Collapsible";

export function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible title="💭 思考过程" summary={`${text.length} 字`} tone="muted">
      <p className="whitespace-pre-wrap break-words text-xs italic text-slate-500 dark:text-slate-400">{text}</p>
    </Collapsible>
  );
}
