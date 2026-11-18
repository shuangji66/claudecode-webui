// 输入框里的 `@` 文件引用：语法、格式化与替换（纯函数）。
//
// 规则与 DSH 的 file-reference grammar 同一套（`@deepseek-ai/dsh-file-reference`）：
//   - 触发符只在**行首或空白之后**才算数，所以 `user@example.com` 不会弹出补全；
//   - 路径含空格时写成 `@"my file.ts"`；进入目录时引号保持打开（`@"my dir/`），
//     这样 Tab 还能继续往下钻；
//   - 选中的值就是普通正文 `@相对路径`，文件内容始终留给模型自己用 Read 工具去读
//     ——补全不把正文塞进上下文。
//
// 这里只做「文本 ↔ token」的纯计算，请求与键盘交互在 `components/chat/useMention.ts`。

/** 光标处一个活着的 `@` token。 */
export interface MentionToken {
  /** 触发符 `@` 在正文里的下标。 */
  start: number;
  /** token 的结束位置（就是光标）。 */
  end: number;
  /** `@` 后面的查询串；`@"…"` 写法里是引号内的内容。 */
  query: string;
  /** 用户显式写了 `@"`（路径含空格时的写法）。 */
  quoted: boolean;
}

/** 引用的是文件还是目录（目录的引用以 `/` 结尾，Tab 还能继续下钻）。 */
export type MentionKind = "file" | "dir";

/** 面包屑的一段：点一下把查询串换成这一层目录。 */
export interface MentionCrumb {
  label: string;
  /** 点击后写回 `@` 后面的查询串（目录路径，不带结尾 `/`）。 */
  query: string;
}

// 只认「行首或空白之后」的 `@`；不写 `m` 标志——`\s` 本来就包含换行。
const QUOTED_TOKEN = /(?:^|\s)(@"([^"]*))$/u;
const PLAIN_TOKEN = /(?:^|\s)(@([^\s]*))$/u;

/**
 * 取光标处的 `@` token；不在 token 里返回 undefined。
 *
 * 引号写法的检查在前：`@"a b` 里的空格是路径的一部分，不能被当成 token 结束。
 */
export function mentionAt(text: string, caret: number): MentionToken | undefined {
  const pos = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, pos);
  const quoted = QUOTED_TOKEN.exec(before);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { start: pos - quoted[1].length, end: pos, query: quoted[2], quoted: true };
  }
  const plain = PLAIN_TOKEN.exec(before);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { start: pos - plain[1].length, end: pos, query: plain[2], quoted: false };
}

/**
 * 把一个路径写成引用文本；无法安全表示时返回 undefined（宁可不插入也不要写坏正文）。
 *
 * `keepQuote` 保留用户已经敲下的引号：在 `@"` 里选文件时，插回去的也应该是引号形式。
 * 目录以 `/` 结尾，引号**故意不闭合**，让补全能继续往下钻。
 */
export function formatMention(path: string, kind: MentionKind, keepQuote = false): string | undefined {
  if (path === "" && kind === "dir") return keepQuote ? '@"' : "@";
  const target = kind === "dir" ? `${path}/` : path;
  // 控制字符、双引号都会让上面两条正则无法稳定回读，一律拒绝。
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(target)) return undefined;
  const quoted = keepQuote || /\s/u.test(target);
  if (!quoted) return `@${target}`;
  return kind === "dir" ? `@"${target}` : `@"${target}"`;
}

/** 用一段文本替换 token（正文其余部分原样保留），返回新正文与新光标。 */
export function applyMention(
  text: string,
  token: MentionToken,
  value: string,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, token.start)}${value}${text.slice(token.end)}`,
    caret: token.start + value.length,
  };
}

/** 查询串里的目录部分（末尾带 `/`）；没有目录时是空串。 */
export function mentionDir(query: string): string {
  const slash = query.lastIndexOf("/");
  return slash < 0 ? "" : query.slice(0, slash + 1);
}

/** 查询串里正在过滤的片段（最后一个 `/` 之后）。 */
export function mentionFragment(query: string): string {
  const slash = query.lastIndexOf("/");
  return slash < 0 ? query : query.slice(slash + 1);
}

/**
 * 当前目录路径的面包屑（不含「根」那一段，根由调用方按自己的文案渲染）。
 *
 * 只在查询串里出现过 `/` 时才有内容：用户自己敲的路径本来就在正文里，
 * 面包屑是给「Tab 钻进去之后」提供的回退入口。
 */
export function mentionCrumbs(query: string): MentionCrumb[] {
  const dir = mentionDir(query).replace(/\/+$/, "");
  if (dir === "") return [];
  const crumbs: MentionCrumb[] = [];
  let prefix = "";
  for (const segment of dir.split("/")) {
    if (segment === "") continue;
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    crumbs.push({ label: segment, query: prefix });
  }
  return crumbs;
}
