import {
  memo,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Item } from "../../lib/model";
import { AssistantBubble } from "./AssistantBubble";
import { ResultBar } from "./ResultBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserBubble } from "./UserBubble";
import { ToolCardHost } from "../tools/ToolCardHost";
import { IconAlert, IconChevronDown, IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { activeTurnIndex, turnsOf, windowStart, type Turn } from "../../lib/turns";
import {
  buildProcessRows,
  hiddenReplyIds,
  isProcessItem,
  replyCopy,
  turnSpans,
  type ProcessEntry,
  type TurnSpan,
} from "../../lib/process";
import { useCollapseTiming, useFoldedReplies, useProcessView } from "../../lib/viewMode";
import { useFollowGrowth } from "../../lib/scrollFollow";
import { useAppStore } from "../../store/useAppStore";
import { ProcessGroup } from "./ProcessGroup";
import { TurnCollapse } from "./TurnCollapse";

/**
 * 这一行是不是「过程」（收起时要藏掉的东西）。
 *
 * 过程组与合并后的思考块都是过程；单条的思考 / 工具也是。正文（assistant）、用户消息、
 * result / interrupt / error 都不算——收起只收过程，正文本就是收起来之后要留下的东西。
 */
function entryTouchesProcess(entry: ProcessEntry): boolean {
  if (entry.type === "process" || entry.type === "thinking") return true;
  return isProcessItem(entry.item);
}

/**
 * 长对话只渲染最近这一批，往上翻时再按批展开。
 *
 * 为什么不是虚拟列表：消息高度差异极大（一行文字 vs 几百行 diff），
 * 自己算高度容易抖；「限制渲染条数 + 离屏跳过布局绘制」足够压住 DOM 规模，
 * 也不会破坏浏览器自带的查找、锚点与无障碍树。
 */
const VISIBLE_STEP = 80;
/**
 * 离屏行不参与布局/绘制；估算高度给滚动条一个稳定长度。
 *
 * **估算值必须贴近真实高度**：估高了，展开一组 80 行时滚动高度会比真实值多出上千像素，
 * 随着行真正渲染再一路回缩——滚起来就是「内容加载不过来」+ 位置乱跳。紧凑过程行只有
 * 一行高（~28px），气泡/卡片才接近 120px，所以按行类型分开估。
 */
const OFFSCREEN_TEXT = { contentVisibility: "auto", containIntrinsicSize: "auto 120px" } as const;
const OFFSCREEN_ROW = { contentVisibility: "auto", containIntrinsicSize: "auto 32px" } as const;

/** 单条消息。memo 化：流式追加时只有最后一个气泡需要重渲染。 */
const MessageRow = memo(function MessageRow({
  item,
  dense = false,
  offscreen = true,
  copyText,
}: {
  item: Item;
  /** 紧凑模式：思考与工具压成一行，正文/用户消息不受影响。 */
  dense?: boolean;
  /**
   * 这一条回答该复制的整轮正文（`lib/process.replyCopy`）；`undefined` 表示不给复制入口。
   *
   * 只有本轮最终回答会拿到值：过渡正文各挂一个复制按钮是噪音，而且复制出来只是半句话。
   */
  copyText?: string;
  /**
   * 是否允许「离屏跳过渲染」。过程组内部一律关掉：那一整块是用户主动展开的，
   * 里面的行又便宜，跳过只会让展开瞬间的高度估算反复回缩。
   */
  offscreen?: boolean;
}) {
  const t = useT();
  const box = (dense: boolean) => ({
    className: "animate-rise",
    style: offscreen === false ? undefined : dense ? OFFSCREEN_ROW : OFFSCREEN_TEXT,
  });
  switch (item.kind) {
    case "user":
      return (
        <div {...box(false)}>
          <UserBubble text={item.text} ts={item.ts} images={item.images} />
        </div>
      );
    case "assistant":
      return (
        <div {...box(false)}>
          <AssistantBubble
            text={item.text}
            streaming={item.streaming}
            ts={item.ts}
            turn={item.turn}
            showCopy={copyText !== undefined}
            copyText={copyText}
          />
        </div>
      );
    case "thinking":
      return (
        <div {...box(dense)}>
          <ThinkingBlock text={item.text} dense={dense} />
        </div>
      );
    case "tool":
      return (
        <div {...box(dense)}>
          <ToolCardHost item={item} dense={dense} />
        </div>
      );
    case "result":
      return <ResultBar item={item} />;
    case "interrupt": {
      // CLI 的「本轮被中断」标记：一句中性提示，不占用户气泡（见 lib/normalize）。
      // 三种原因说三句话：把「进程被结束」说成「已中断」，用户会以为是自己停的。
      const label =
        item.reason === "session"
          ? t("会话已结束，本轮未完成", "Session ended before this turn finished")
          : item.reason === "agent"
            ? t("子代理被中断", "Subagent interrupted")
            : t("已中断", "Interrupted");
      return (
        <div className="flex justify-center py-0.5">
          <span className="rounded-full border border-line bg-panel px-2 py-0.5 text-[10.5px] text-muted">
            {label}
          </span>
        </div>
      );
    }
    case "system":
      return (
        <pre
          style={OFFSCREEN_TEXT}
          className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-relaxed text-muted"
        >
          {item.text}
        </pre>
      );
    case "error":
      return (
        <div
          style={OFFSCREEN_TEXT}
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
  /** 滚动内容的外层：它的高度变化（展开折叠块、图片加载）触发贴底跟随。 */
  const content = useRef<HTMLDivElement>(null);
  /** 贴底跟随：用户往上翻就停下，回到底部再恢复。 */
  const stick = useRef(true);
  const [limit, setLimit] = useState(VISIBLE_STEP);
  const [atBottom, setAtBottom] = useState(true);
  /** 不贴底时来了新内容：按钮上点一个提示点。 */
  const [unseen, setUnseen] = useState(false);
  const prevCount = useRef(items.length);

  /**
   * 上一次见到的最后一条用户消息 id：变了就说明「用户刚发了一条」。
   *
   * 只在切换对话时重置（`resetKey`），**不在用户往上翻时重置**——这个 ref 记的是
   * 「最后一条用户消息是谁」，与滚动位置无关。
   */
  const lastUserSent = useRef<string | null>(null);
  /** 展开更早消息前记录的「距底部距离」，用于展开后保持视口不动。 */
  const anchorFromBottom = useRef<number | null>(null);
  /** 轮次刻度：每条用户消息一个刻度，点一下跳到那一轮。 */
  const turns = useMemo(() => turnsOf(items), [items]);
  const [activeTurn, setActiveTurn] = useState(0);
  const rafPending = useRef<number | null>(null);
  /** 滚动停止计时器：停止后重量一次几何，兜住「上方内容高度变化」的情况。 */
  const scrollSettle = useRef<number | null>(null);
  /** 跳转目标被窗口截掉时，先展开再滚。 */
  const pendingJump = useRef<string | null>(null);

  const scrollToItem = (id: string) => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
    if (!sc || !el) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 8;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (!reduce && typeof sc.scrollTo === "function") sc.scrollTo({ top, behavior: "smooth" });
    else sc.scrollTop = top;
  };

  const jumpToTurn = (turn: Turn) => {
    const need = items.length - turn.index;
    if (need > limit) {
      pendingJump.current = turn.id;
      setLimit(need);
      return;
    }
    scrollToItem(turn.id);
  };

  const hidden = useMemo(() => windowStart(items, limit), [items, limit]);
  const shown = useMemo(() => (hidden > 0 ? items.slice(hidden) : items), [items, hidden]);
  /**
   * 过程展示偏好决定「展开之后每一步怎么画」：detailed 完整卡片、standard 一步一行、
   * concise 把连续的过程折成一行摘要。**收起是另一条轴、且是轮级的**（见下面的 `spans`）。
   */
  const view = useProcessView();
  const dense = view !== "detailed";
  const grouping = view === "concise";
  /**
   * 收起时机：整轮过程什么时候收进轮首那一行。
   *
   *   - `onComplete`（默认）：这一轮一结束（有 `result`，或会话已经空闲的回放）就收；
   *   - `onNextSend`：最新一轮结束后仍保持展开，等用户发出下一条消息才收——那时它不再是
   *     最新一轮，于是自动落进上一条。
   *
   * **跑到一半的轮永远不收**：把正在执行的步骤藏起来等于让人不知道它在干什么。
   * 用户手动点过的那一轮记在 `manual` 里，自动逻辑不再改它（点开历史轮就该一直开着）。
   */
  const timing = useCollapseTiming();
  /**
   * 「仅最终回答」：只有**最新一轮**在过程仍展开时才保留全部回复；
   * 其余轮次（以及已完成的最新一轮）只留最后一条回答。
   *
   * 「最新一轮结束了没有」认会话状态而不是「有没有 result」：转录回放里没有 result 行，
   * 按它判断的话重开一个旧对话会让最新一轮永远保持展开。
   */
  const folded = useFoldedReplies();
  const running = useAppStore((s) => {
    const st = s.states[s.activeId ?? ""];
    return st === "busy" || st === "starting";
  });
  const keepTail = timing === "onNextSend" || running;
  const hiddenReplies = useMemo(
    () => (folded === "final" ? hiddenReplyIds(shown, keepTail) : null),
    [folded, shown, keepTail],
  );
  /**
   * 轮级收起。键用轮首那条的 id：数组下标会随「加载更早」整体平移，用它当键会把
   * 展开态错配到别的轮上。
   */
  const spans = useMemo(() => turnSpans(shown, running), [shown, running]);
  const [manual, setManual] = useState<Record<string, boolean>>({});
  /** 某一轮此刻是不是收起态。 */
  const isCollapsed = (span: TurnSpan, index: number): boolean => {
    if (span.process.length === 0) return false; // 没有过程可收：纯问答不该多一行
    if (!span.finished) return false; // 还在跑：过程必须看得见
    const key = shown[span.start].id;
    const touched = manual[key];
    if (touched !== undefined) return !touched;
    return !(timing === "onNextSend" && index === spans.length - 1);
  };
  /** 每轮各自成行：分组只在轮内发生，跨轮的分组没有意义。 */
  const rows = useMemo(
    () =>
      spans.map((span) =>
        buildProcessRows(shown.slice(span.start, span.end), grouping).map((row) => ({
          ...row,
          start: row.start + span.start,
        })),
      ),
    [spans, shown, grouping],
  );
  /**
   * 每条回答该复制的整轮正文（`lib/process.replyCopy`）：只有本轮最终回答拿得到值，
   * 过渡正文拿不到——它们也就不用渲染复制按钮。
   *
   * **这一轮没结束就一个都不给**：跑到一半时「最后一条正文」只是半句话，挂个复制按钮
   * 既没意义，又会在过程里冒出来（用户看到的就是「思考过程下面多了一个复制按钮」）。
   */
  const copies = useMemo(() => {
    const map = new Map<string, string>();
    for (const span of spans) {
      const slice = shown.slice(span.start, span.end);
      for (const item of slice) {
        if (item.kind !== "assistant") continue;
        const text = replyCopy(slice, item.id, span.finished);
        if (text !== undefined) map.set(item.id, text);
      }
    }
    return map;
  }, [spans, shown]);

  /**
   * 每一轮用户消息相对「滚动内容顶部」的距离，缓存给滚动帧用。
   *
   * 以前 onScroll 每帧对每一轮做 querySelector + getBoundingClientRect：读几何会
   * 触发强制同步布局，几百轮的会话滚一下就几百次查询 + 一次重排。现在几何只在
   * 「内容 / 窗口 / 尺寸」变化时量一次（且只量真正渲染出来的那批），滚动帧只做
   * 一次数组比较。
   */
  const turnTops = useRef<number[]>([]);
  /** 上一次量几何时的「轮次签名 + 窗口起点」：相同就不必再量。 */
  const turnSig = useRef<string>("");

  const measureTurns = useCallback(
    (force = false) => {
      const sc = scroller.current;
      if (!sc || turns.length === 0) {
        turnTops.current = [];
        turnSig.current = "";
        return;
      }
      // 流式追加只会往最后一轮里加内容，不会移动任何轮的锚点位置：签名没变就不量。
      // 这样长对话流式输出时一次布局读取都不会发生（真正需要重量的是新的一轮、
      // 展开更早的消息、以及容器尺寸变化）。
      const sig = `${hidden}#${turns.map((tn) => tn.id).join("|")}`;
      if (!force && sig === turnSig.current) return;
      turnSig.current = sig;
      // 被「最近 N 条」窗口截掉的轮次没有 DOM 节点，但它们一定在视口上方：
      // 用 -Infinity 参与比较，不必去查一个不存在的元素。
      const origin = sc.getBoundingClientRect().top - sc.scrollTop;
      turnTops.current = turns.map((turn) => {
        if (turn.index < hidden) return Number.NEGATIVE_INFINITY;
        const el = sc.querySelector<HTMLElement>(`[data-item-id="${turn.id}"]`);
        return el ? el.getBoundingClientRect().top - origin : Number.NEGATIVE_INFINITY;
      });
    },
    [turns, hidden],
  );

  /**
   * 视口顶部落在哪一轮：只读缓存，不碰 DOM。
   *
   * 贴底时直接算最后一轮（`atBottom`）：贴底那一刻视口顶部通常还停在上一轮的正文里，
   * 按位置算会一直亮着上一轮——「滚到底了刻度却没走到最后一个」。
   */
  const syncActiveTurn = useCallback(() => {
    const sc = scroller.current;
    if (!sc || turnTops.current.length === 0) return;
    setActiveTurn(activeTurnIndex(turnTops.current, sc.scrollTop, undefined, stick.current));
  }, []);

  // 内容、窗口或容器尺寸变化后重新量一次，并按当前滚动位置校准刻度。
  useLayoutEffect(() => {
    measureTurns();
    // 容器还没布局出来（隐藏的标签页、测试环境）时几何全是 0，校准只会把刻度
    // 算到最后一轮；等真的滚起来再算。
    if ((scroller.current?.scrollHeight ?? 0) > 0) syncActiveTurn();
  }, [measureTurns, syncActiveTurn]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    // 视口宽度/高度变化会改变换行与行高，缓存随之失效；合并到一帧里重量。
    //
    // **还要重新贴底**：这个滚动区的高度不是固定的——输入区上方的审批卡片、任务清单、
    // 「少女祈祷中」计时行出现/消失都会挤占它的高度。高度一变，`scrollTop` 停在原处就
    // 不再是最底部（内容没动、视口变矮了），于是「回到底部」按钮自己冒出来、还带个
    // 「有新内容」的圆点，看起来像用户自己翻上去了。贴底时高度变化必须跟到底。
    const ro = new ResizeObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        if (stick.current) {
          // 高度变化本身不是「用户往上滚」，不要用它去判贴底——只认 `stick`（由
          // onScroll 的方向判定维护）。这里**不做**「已经在底部就跳过」的优化：
          // 这次回调的触发原因就是几何变了，此刻的 scrollHeight/scrollTop 恰好在
          // 旧值上仍然自洽（视口变矮时差值是正的、变高时也可能是 0），按它们判断会
          // 跳过写入，滚动位置就此停在离底部更远的地方。
          sc.scrollTop = sc.scrollHeight;
          setAtBottom(true);
          setUnseen(false);
        }
        measureTurns(true); // 尺寸变了行高就变了，必须重量
        syncActiveTurn();
      });
    });
    ro.observe(sc);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measureTurns, syncActiveTurn]);

  useEffect(() => {
    setLimit(VISIBLE_STEP);
    stick.current = true;
    setAtBottom(true);
    setUnseen(false);
    prevCount.current = items.length;
    // 换对话：新会话的第一条 user 不是「刚发的」，别在挂载时额外触发一次强制贴底。
    lastUserSent.current = items[items.length - 1]?.kind === "user" ? items[items.length - 1].id : null;
  }, [resetKey]);

  // 距底部距离：窗口是「尾部 limit 条」，消息一增长窗口就整体上移一条，
  // 最上面那条会离开 DOM。用户正在往上翻（不贴底）时要靠这个值还原视口，
  // 否则他正在读的那条会直接消失。onScroll 里持续记录，代价是一次减法。
  const distFromBottom = useRef<number | null>(null);

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

  // 内容变高（展开思考过程 / 工具卡片、图片加载完、流式追加一段）也跟随贴底。
  //
  // 上面那个 effect 只认条数变化：展开一个折叠块不改 items，新露出来的正文就留在
  // 视口外，点开像没反应。这里按内容容器的高度变化补上，规则与滚动本身一致——
  // 用户往上滚过（不贴底）就不跟，滚回底部自然恢复，不额外给状态。
  useFollowGrowth(scroller, content, () => stick.current);

  // 展开更早的消息后把视口钉在原来那条消息上，别让它「跳一下」。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && anchorFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - anchorFromBottom.current;
      anchorFromBottom.current = null;
    }
    const jump = pendingJump.current;
    if (jump) {
      pendingJump.current = null;
      scrollToItem(jump);
    }
  }, [limit]);

  // 窗口整体上移（`hidden` 变了）时还原视口，以及**用户自己发消息时强制贴底**。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const dist = distFromBottom.current;
    /**
     * **用户自己刚发了一条**：无论此刻滚到哪儿都回到底部并恢复跟随。
     *
     * 用户往上翻着读历史、直接发一句话，界面却停在他读的那段、自己刚发的气泡和后面的
     * 回复全在视口外，看起来就像「发了没反应」。这是唯一会强行接管滚动的情况——别人发来的
     * 消息（另一台设备、定时任务投递）仍然遵守「往上翻就停下」。
     *
     * 判定放在这里而不是下面那个 effect：`hidden > 0` 的「还原视口」也在这段跑，
     * 放到后面会把刚滚到底的位置又按旧距离还原回去（闪一帧再跳回）。
     */
    const tail = items[items.length - 1];
    const sentNow = tail?.kind === "user" && tail.id !== lastUserSent.current;
    if (tail?.kind === "user") lastUserSent.current = tail.id;
    if (sentNow) {
      stick.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (!stick.current && hidden > 0 && dist !== null) {
      el.scrollTop = el.scrollHeight - dist;
    }
  }, [items, hidden]);

  // 滚动停止后重量一次：折叠/展开卡片、图片加载完成都会让上面的高度变化，
  // 而轮次签名没变、缓存不会自动失效。趁用户没在滚（也没有布局竞争）时补一次。
  useEffect(() => {
    return () => {
      if (scrollSettle.current !== null) window.clearTimeout(scrollSettle.current);
    };
  }, []);

  /**
   * 上一次 scroll 事件的 scrollTop：判断用户是在往上滚还是在往下滚。
   *
   * **贴底状态只认滚动方向，不认「距底多远」**（以前是 `距底 < 100`）。那个判法在流式
   * 输出下会自己把跟随关掉：跟随把 scrollTop 推到底之后，内容往往在下一个 scroll 事件
   * 被处理前又长高了一截，事件到达时距底已经 > 100，于是被判成「用户往上翻了」，
   * 从此不再跟随——表现就是「滚着滚着突然不跟了，得手动点一次回到底部」。
   * 内容变高只会让 scrollTop 不变或变大，不会伪装成「往上滚」。
   */
  const lastTop = useRef<number | null>(null);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const prev = lastTop.current;
    lastTop.current = top;
    if (scrollSettle.current !== null) window.clearTimeout(scrollSettle.current);
    scrollSettle.current = window.setTimeout(() => {
      scrollSettle.current = null;
      measureTurns(true);
      syncActiveTurn();
    }, 150);
    distFromBottom.current = el.scrollHeight - top;
    const bottom = el.scrollHeight - top - el.clientHeight;
    // 往上滚 = 用户要离开底部；滚到底 = 恢复跟随。其余情况（内容长高导致的位置变化）
    // 保持当前状态，不要拿它改判。阈值给 2px 抖动量，避免亚像素误差来回翻。
    if (prev !== null && top < prev - 2) stick.current = false;
    else if (bottom <= 2) stick.current = true;
    setAtBottom(stick.current);
    if (stick.current) setUnseen(false);
    if (rafPending.current === null) {
      rafPending.current = window.requestAnimationFrame(() => {
        rafPending.current = null;
        syncActiveTurn();
      });
    }
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
        className={`dsh-scroll h-full overflow-y-auto ${turns.length >= 2 ? "dsh-scroll-none-md" : ""}`}
        onScroll={onScroll}
      >
        <div
          ref={content}
          // 上下内边距分开写：下方贴着输入区，`py-8` 的 32px 加上末尾的 spacer
          // 会叠出一大片空白（底部跟随之后那片空白更显眼）。
          className={`mx-auto w-full max-w-[820px] px-4 pb-2 pt-6 md:px-6 md:pb-3 md:pt-8 ${turns.length >= 2 ? "md:pr-10" : ""}`}
        >
          <div className={dense ? "" : "space-y-5"}>
            {hidden > 0 && (
              <div className={`flex justify-center ${dense ? "mt-3" : ""}`}>
                <button
                  type="button"
                  onClick={loadEarlier}
                  className="rounded-full border border-line-strong bg-canvas px-3 py-1 text-[11.5px] text-muted transition hover:bg-panel-strong hover:text-ink"
                >
                  {t(`加载更早的 ${Math.min(VISIBLE_STEP, hidden)} 条`, `Load ${Math.min(VISIBLE_STEP, hidden)} earlier`)}
                </button>
              </div>
            )}
            {spans.map((span, index) => {
              const collapsed = isCollapsed(span, index);
              const turnRows = rows[index];
              /**
               * 收起/展开那一行（DSH 的「已完成，用时 …」）。
               *
               * **位置在用户消息下方、这一轮第一条答复上方**：放到轮首会跑到用户气泡
               * 上方，一进来只看见一行「已完成」还以为自己刚发的话被折没了。
               * 有过程才出现——纯问答不该多一行。
               */
              const collapseRow = span.process.length > 0 && span.finished && (
                <TurnCollapse
                  durationMs={span.durationMs}
                  open={!collapsed}
                  onToggle={() => {
                    // `manual` 记的是「用户要它展开吗」：点一下就是取反当前的收起态。
                    const key = shown[span.start].id;
                    setManual((prev) => ({ ...prev, [key]: collapsed }));
                  }}
                />
              );
              // 只有窗口截断把用户消息切掉时，第一行才不是用户消息：那种情况放在最前面。
              const head = turnRows[0];
              const headIsUser = head?.type === "item" && head.item.kind === "user";
              return (
                <Fragment key={shown[span.start].id}>
                  {!headIsUser && collapseRow}
                  {turnRows.map((entry, rowIndex) => {
                    // 过程收起来了：整批跳过，只留正文。正文与用户消息是「结果」，
                    // 收起要藏的只有过程（思考与工具调用）。
                    if (collapsed && entryTouchesProcess(entry)) return null;
                    // 「仅最终回答」：阶段回复整行跳过，不缩成一行占位。
                    if (entry.type === "item" && hiddenReplies?.has(entry.item.id)) return null;
                    let row: ReactNode = null;
                    if (entry.type === "process") {
                      row = (
                        <div key={entry.key} className={dense ? "mt-1" : undefined}>
                          <ProcessGroup items={entry.items}>
                            {entry.items.map((item) => (
                              <MessageRow key={item.id} item={item} dense={dense} offscreen={false} />
                            ))}
                          </ProcessGroup>
                        </div>
                      );
                    } else if (entry.type === "thinking") {
                      row = (
                        <div key={entry.key} className={dense ? "mt-1" : undefined}>
                          <ThinkingBlock text={entry.items.map((it) => it.text).join("\n\n")} dense={dense} />
                        </div>
                      );
                    } else {
                      row = (
                        <div
                          key={entry.key}
                          data-item-id={entry.item.id}
                          className={dense ? (isProcessItem(entry.item) ? "mt-1" : "mt-5") : undefined}
                        >
                          <MessageRow
                            item={entry.item}
                            dense={dense}
                            copyText={entry.item.kind === "assistant" ? copies.get(entry.item.id) : undefined}
                          />
                        </div>
                      );
                    }
                    if (rowIndex === 0 && headIsUser) {
                      return (
                        <Fragment key={entry.key}>
                          {row}
                          {collapseRow}
                        </Fragment>
                      );
                    }
                    return <Fragment key={entry.key}>{row}</Fragment>;
                  })}
                </Fragment>
              );
            })}
          </div>
          {/* 末尾留一小段呼吸：最后一条回答的用量行贴着输入区会很挤，但不必再给 24px。 */}
          <div className="h-1" />
        </div>
      </div>

      {/* 刻度栏只在 md 以上出现：手机上那 20px 是从正文里硬挤出来的，3px 高的
          刻度也不好点，横向滑动还容易误触。手机上保留原生滚动条作为「还能滚」的提示。 */}
      {turns.length >= 2 && (
        <div
          data-testid="turn-rail"
          className="pointer-events-none absolute bottom-16 right-1 top-6 hidden w-5 items-center justify-center md:flex"
        >
          <div className="dsh-scroll-none pointer-events-auto flex max-h-full flex-col items-end gap-[3px] overflow-y-auto py-1 pr-0.5">
            {turns.map((turn, index) => (
              <button
                key={turn.id}
                type="button"
                onClick={() => jumpToTurn(turn)}
                aria-label={t(`跳到第 ${index + 1} 轮：${turn.label}`, `Jump to turn ${index + 1}: ${turn.label}`)}
                aria-current={index === activeTurn ? "true" : undefined}
                title={turn.label}
                className={`h-[3px] shrink-0 rounded-full transition-all ${
                  index === activeTurn ? "w-[18px] bg-brand" : "w-2.5 bg-faint hover:w-4 hover:bg-muted"
                }`}
              />
            ))}
          </div>
        </div>
      )}

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
