import { useMemo, type ReactNode } from "react";

interface Segment {
  type: "text" | "code";
  lang?: string;
  content: string;
}

/** 按 ``` 围栏切分文本；未闭合的围栏按普通文本处理，避免整段丢失。 */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: "text", content: text.slice(last, m.index) });
    out.push({ type: "code", lang: m[1] || undefined, content: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", content: text.slice(last) });
  return out.length > 0 ? out : [{ type: "text", content: text }];
}

/** 行内 `code` 与 **bold**，不做 HTML 注入，全部走 React 节点。 */
export function renderInline(s: string, keyPrefix = "i"): ReactNode[] {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.filter(Boolean).map((p, i) => {
    const key = `${keyPrefix}-${i}`;
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) {
      return (
        <code key={key} className="rounded-md bg-panel-strong px-1 py-0.5 font-mono text-[0.86em] text-ink-2">
          {p.slice(1, -1)}
        </code>
      );
    }
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      return <strong key={key} className="font-semibold text-ink">{p.slice(2, -2)}</strong>;
    }
    return <span key={key}>{p}</span>;
  });
}

/** 极简 Markdown：代码块 + 段落 + 行内标记。刻意不引第三方渲染库。 */
export function Markdown({ text }: { text: string }) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <div className="space-y-3 text-[14.5px] leading-[1.75]">
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <pre key={i} className="overflow-x-auto rounded-xl border border-line bg-[#0f1115] p-3 text-[12px] leading-relaxed text-[#e5e7eb]">
            <code>{seg.content.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          seg.content
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => (
              <p key={`${i}-${j}`} className="whitespace-pre-wrap break-words">
                {renderInline(p, `${i}-${j}`)}
              </p>
            ))
        ),
      )}
    </div>
  );
}
