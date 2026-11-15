import { Collapsible } from "../common/Collapsible";

export function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible title="思考过程" summary={`${text.length} 字`} tone="muted">
      <p className="whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-muted">{text}</p>
    </Collapsible>
  );
}
