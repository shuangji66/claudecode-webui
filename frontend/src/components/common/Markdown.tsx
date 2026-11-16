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

/** 只放行 http(s)/mailto 与相对地址：Markdown 里的链接来自模型输出，不能当脚本入口。 */
function safeHref(raw: string): string | undefined {
  const u = raw.trim();
  if (!u) return undefined;
  if (/^(?:https?:|mailto:)/i.test(u)) return u;
  // 没有协议头的按相对地址处理（`#anchor`、`./a.md`）。
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return undefined;
}

// 行内标记：代码 > 链接 > 粗体 > 删除线 > 斜体。
// 代码排在最前，里面的 * 和 _ 才不会被当成标记；下划线强调要求词边界，
// 否则 my_file_name.txt 这种文件名会被拆成斜体。
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|((?<![\w*])\*[^*\n]+\*(?![\w*]))|((?<![\w_])_[^_\n]+_(?![\w_]))/g;

/** 行内 `code`、**bold**、*italic*、~~del~~、[链接](url)，不做 HTML 注入。 */
export function renderInline(s: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let idx = 0;
  // 每次调用都新建正则：链接文字要递归调用 renderInline，共用一个全局正则会把
  // 外层的 lastIndex 改掉，直接死循环。
  const re = new RegExp(INLINE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      out.push(<span key={`${keyPrefix}-${idx++}`}>{s.slice(last, m.index)}</span>);
    }
    const token = m[0];
    const key = `${keyPrefix}-${idx++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="rounded-md bg-panel-strong px-1 py-0.5 font-mono text-[0.86em] text-ink-2">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : undefined;
      if (link && href) {
        out.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
          >
            {renderInline(link[1], key)}
          </a>,
        );
      } else {
        out.push(<span key={key}>{token}</span>);
      }
    } else if (m[3] || m[4]) {
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (m[5]) {
      out.push(
        <del key={key} className="text-muted">
          {token.slice(2, -2)}
        </del>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < s.length) out.push(<span key={`${keyPrefix}-tail`}>{s.slice(last)}</span>);
  return out;
}

export type Block =
  | { type: "code"; lang?: string; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: { text: string; indent: number }[] }
  | { type: "quote"; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "hr" }
  | { type: "para"; text: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const QUOTE_RE = /^>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d{1,9}[.)]\s+(.*)$/;
const FENCE_RE = /^```([\w+-]*)\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** 表格分隔行：`|---|---|` / `:--|--:`。 */
function isTableSep(line: string): boolean {
  const s = line.trim();
  if (!s.includes("-") || !s.includes("|")) return false;
  return /^\|?[\s:|-]+$/.test(s);
}

/**
 * 把正文切成块。刻意保持极简（不引第三方渲染库），但覆盖模型输出里最常见的
 * 结构：标题、列表、表格、引用、分割线、段落、代码块。
 */
export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  let i = 0;

  const flush = () => {
    if (para.length > 0) {
      out.push({ type: "para", text: para.join("\n") });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      i += 1;
      continue;
    }

    // 正文段里仍可能出现围栏（例如 splitFences 未命中的缩进围栏）。
    const fence = FENCE_RE.exec(trimmed);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push({ type: "code", lang: fence[1] || undefined, content: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flush();
      out.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (HR_RE.test(trimmed)) {
      flush();
      out.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(trimmed)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i].trim());
        if (!q) break;
        buf.push(q[1]);
        i += 1;
      }
      out.push({ type: "quote", text: buf.join("\n") });
      continue;
    }

    if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push({ type: "table", head, rows });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      flush();
      const ordered = Boolean(ol);
      const items: { text: string; indent: number }[] = [];
      while (i < lines.length) {
        const cur = ordered ? OL_RE.exec(lines[i]) : UL_RE.exec(lines[i]);
        if (!cur) break;
        items.push({
          indent: Math.floor(cur[1].replace(/\t/g, "  ").length / 2),
          text: cur[2],
        });
        i += 1;
      }
      out.push({ type: "list", ordered, items });
      continue;
    }

    para.push(line);
    i += 1;
  }
  flush();
  return out;
}

const HEADING_SIZE = [
  "text-[19px]",
  "text-[17px]",
  "text-[15.5px]",
  "text-[14px]",
  "text-[13px]",
  "text-[12.5px]",
];

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.type) {
    case "code":
      return (
        <pre
          key={key}
          className="chat-code overflow-x-auto rounded-xl border border-line bg-[#0f1115] p-3 leading-relaxed text-[#e5e7eb]"
        >
          <code>{b.content.replace(/\n$/, "")}</code>
        </pre>
      );
    case "heading": {
      const cls = `font-semibold text-ink ${HEADING_SIZE[Math.min(Math.max(b.level, 1), 6) - 1]}`;
      const children = renderInline(b.text, `h${key}`);
      const Tag = (`h${b.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
      return (
        <Tag key={key} className={cls}>
          {children}
        </Tag>
      );
    }
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={key} className={`${b.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
          {b.items.map((it, j) => (
            <li key={j} style={it.indent > 0 ? { marginLeft: it.indent * 12 } : undefined}>
              {renderInline(it.text, `l${key}-${j}`)}
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="border-l-2 border-line pl-3 text-muted">
          <p className="whitespace-pre-wrap break-words">{renderInline(b.text, `q${key}`)}</p>
        </blockquote>
      );
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="min-w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {b.head.map((cell, j) => (
                  <th
                    key={j}
                    className="border border-line bg-panel px-2 py-1 text-left font-semibold text-ink"
                  >
                    {renderInline(cell, `th${key}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k} className="border border-line px-2 py-1 align-top text-ink-2">
                      {renderInline(cell, `td${key}-${j}-${k}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} className="border-line" />;
    case "para":
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {renderInline(b.text, `p${key}`)}
        </p>
      );
    default:
      return null;
  }
}

/** 极简 Markdown：块级结构 + 行内标记，全部走 React 节点，不碰 dangerouslySetInnerHTML。 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: Block[] = [];
    for (const seg of splitFences(text)) {
      if (seg.type === "code") out.push({ type: "code", lang: seg.lang, content: seg.content });
      else out.push(...parseBlocks(seg.content));
    }
    return out;
  }, [text]);

  return <div className="chat-text space-y-3">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}
