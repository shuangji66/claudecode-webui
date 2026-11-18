// `@` 文件补全的交互状态：拉候选、防抖、键盘仲裁、选中/下钻。
//
// 组件的职责划分与 DSH 的 input-trigger 一致：**检测与替换是纯函数**
// （`lib/mention.ts`），这里只做「光标处有没有 token → 要不要请求 → 按键怎么处理」，
// 渲染在 `MentionMenu`。请求经 store（`completePaths`），组件不直接 fetch。
//
// 三条容易改错的边界：
//   - 菜单开着时 Tab 是「进入目录」而不是切焦点，↑↓ 是选候选而不是移光标，
//     Enter 是「引用这一行」而不是发送——全部必须 preventDefault，否则一件都做不到；
//   - 候选还在路上（loading）时不能拿上一轮的行去插入：那会把旧查询的路径写进正文；
//   - Esc 关掉之后，同一个 token 不能因为重渲染又弹回来（靠 dismissed 记住 token 身份）。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FsEntry } from "../../transport/types";
import { useAppStore } from "../../store/useAppStore";
import {
  applyMention,
  formatMention,
  mentionAt,
  mentionCrumbs,
  mentionDir,
  type MentionCrumb,
  type MentionToken,
} from "../../lib/mention";

/** 一次按键里本钩子关心的字段（textarea 的 KeyboardEvent 子集，便于测试）。 */
export interface MentionKeyEvent {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean };
  preventDefault: () => void;
}

/** 菜单里的一行。`fnos` 是「从飞牛选择」（只在飞牛宿主里出现），排在工作区候选之后。 */
export interface MentionRow {
  /** 相对工作区根的路径；飞牛行是空串。 */
  path: string;
  name: string;
  kind: "file" | "dir" | "fnos";
  /** 父目录（已经在看这一层、或者根目录下的行不带）。 */
  location?: string;
}

const DEBOUNCE_MS = 120;

export interface MentionController {
  open: boolean;
  rows: MentionRow[];
  crumbs: MentionCrumb[];
  highlight: number;
  loading: boolean;
  error: string | null;
  hover: (index: number) => void;
  pick: (index: number) => void;
  drill: (index: number) => void;
  /** 面包屑：把 `@` 后面的查询串换成某一层目录（空串 = 工作区根）。 */
  jumpTo: (query: string) => void;
  close: () => void;
  /** 处理一次按键；返回 true 表示输入框不该再走自己的默认行为。 */
  handleKey: (event: MentionKeyEvent) => boolean;
}

export interface MentionOptions {
  /** 补全的根（会话 cwd，新对话时是当前工作区）；空串表示还没有授权目录。 */
  cwd: string;
  text: string;
  caret: number;
  /** 用新正文与新光标替换输入框内容。 */
  apply: (text: string, caret: number) => void;
  /** 打开飞牛选择器；token 是用户敲下的那段（调用方负责把它换成选中的路径）。 */
  onFnos: (token: MentionToken) => void;
  /**
   * 菜单里要不要给「从飞牛选择」那一行。
   *
   * 不在飞牛宿主里（独立浏览器 / TCP 直连端口）时必须为 false：那一行的唯一动作是调
   * 宿主桥接，摆出来只会得到一个「当前不在飞牛宿主中」的报错。
   */
  fnos: boolean;
}

export function useMention({ cwd, text, caret, apply, onFnos, fnos }: MentionOptions): MentionController {
  const completePaths = useAppStore((s) => s.completePaths);
  const token = useMemo(() => mentionAt(text, caret), [text, caret]);
  const query = token?.query ?? "";
  const quoted = token?.quoted ?? false;
  // 关闭只对「当前这一个 token」生效：同一个 token 的查询串变了就是新的意图。
  const [dismissed, setDismissed] = useState("");
  const tokenKey = token ? `${token.start}:${token.end}:${quoted ? 1 : 0}:${query}` : "";
  const open = token !== undefined && cwd !== "" && tokenKey !== dismissed;

  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 候选：按 token 变化防抖；新请求发出前取消上一次（慢盘上的迟到响应不该覆盖新结果）。
  useEffect(() => {
    if (!open) {
      setEntries([]);
      setLoading(false);
      setError(null);
      setHighlight(-1);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      completePaths(cwd, query, controller.signal)
        .then((listing) => {
          if (controller.signal.aborted) return;
          // 后端保证 entries 是数组；这里仍然兜一次 null（旧二进制 / 半截响应）。
          const found = (listing.entries ?? []).filter((entry) => entry.type !== "other");
          setEntries(found);
          setHighlight(found.length > 0 ? 0 : -1);
          setError(null);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setEntries([]);
          setHighlight(-1);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, open, query, completePaths]);

  const dir = useMemo(() => mentionDir(query), [query]);
  const rows = useMemo<MentionRow[]>(() => {
    const list = entries.map((entry): MentionRow => {
      const slash = entry.path.lastIndexOf("/");
      const parent = slash < 0 ? "" : entry.path.slice(0, slash);
      return {
        path: entry.path,
        name: slash < 0 ? entry.path : entry.path.slice(slash + 1),
        kind: entry.type === "dir" ? "dir" : "file",
        // 正在看的这一层由面包屑说明，行里不再重复父路径。
        ...(parent !== "" && `${parent}/` !== dir ? { location: parent } : {}),
      };
    });
    if (fnos) list.push({ path: "", name: "fnos", kind: "fnos" });
    return list;
  }, [entries, dir, fnos]);

  const crumbs = useMemo(() => mentionCrumbs(query), [query]);

  const close = useCallback(() => {
    if (tokenKey !== "") setDismissed(tokenKey);
  }, [tokenKey]);

  const hover = useCallback(
    (index: number) => {
      setHighlight(index >= 0 && index < rows.length ? index : -1);
    },
    [rows.length],
  );

  /** 把 token 换成 value（目录引用不带尾随空格，好让补全继续往下钻）。 */
  const replaceToken = useCallback(
    (value: string) => {
      if (!token) return;
      const applied = applyMention(text, token, value);
      apply(applied.text, applied.caret);
    },
    [token, text, apply],
  );

  const jumpTo = useCallback(
    (next: string) => {
      const mention = formatMention(next, "dir", quoted);
      if (mention === undefined) return;
      replaceToken(mention);
    },
    [quoted, replaceToken],
  );

  const drill = useCallback(
    (index: number) => {
      const row = rows[index];
      if (loading || !row || row.kind !== "dir") return;
      const mention = formatMention(row.path, "dir", quoted);
      if (mention === undefined) return;
      // 目录引用以 `/` 结尾（引号保持打开），替换后光标仍在 token 里：
      // 下一次渲染会按新查询拉这一层的内容，菜单不关。
      replaceToken(mention);
    },
    [loading, rows, quoted, replaceToken],
  );

  const pick = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row || !token) return;
      // 飞牛入口与查询无关，候选还在路上时也能点；工作区候选则必须等新一轮结果
      // （否则会把上一次查询的目录/文件写进正文）。
      if (row.kind === "fnos") {
        onFnos(token);
        return;
      }
      if (loading) return;
      const mention = formatMention(row.path, row.kind, quoted);
      if (mention === undefined) return;
      // 文件/目录引用后面补一个空格：token 到这儿结束，菜单随之关闭。
      replaceToken(`${mention} `);
    },
    [loading, rows, token, quoted, onFnos, replaceToken],
  );

  const handleKey = useCallback(
    (event: MentionKeyEvent): boolean => {
      if (!open || !token || event.nativeEvent.isComposing) return false;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlight((prev) => (rows.length === 0 ? -1 : (prev + 1) % rows.length));
          return true;
        case "ArrowUp":
          event.preventDefault();
          setHighlight((prev) => (rows.length === 0 ? -1 : (prev - 1 + rows.length) % rows.length));
          return true;
        case "Escape":
          event.preventDefault();
          close();
          return true;
        case "Tab": {
          event.preventDefault();
          if (event.shiftKey) {
            close();
            return true;
          }
          const row = rows[highlight];
          // 候选还在路上：吞掉 Tab，既不插入上一轮的行，也不让焦点跳走。
          if (!row) return true;
          if (row.kind === "dir") drill(highlight);
          else pick(highlight);
          return true;
        }
        case "Enter": {
          if (event.shiftKey) return false; // 换行照旧
          // 候选未就绪：既不插入旧行，也不把半截 `@查询` 发出去。
          if (loading) {
            event.preventDefault();
            return true;
          }
          if (!rows[highlight]) return false; // 没有候选 → 当普通发送
          event.preventDefault();
          pick(highlight);
          return true;
        }
        default:
          return false;
      }
    },
    [open, token, rows, highlight, loading, close, drill, pick],
  );

  return { open, rows, crumbs, highlight, loading, error, hover, pick, drill, jumpTo, close, handleKey };
}
