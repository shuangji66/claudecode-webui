import {
  memo,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { Item, ToolItem } from "../../lib/model";
import { AssistantBubble } from "./AssistantBubble";
import { ResultBar } from "./ResultBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserBubble } from "./UserBubble";
import { ToolCardHost } from "../tools/ToolCardHost";
import { AskReplyBubble } from "../tools/AskReplyBubble";
import { isAnsweredAsk } from "../../lib/askQuestion";
import { IconAlert, IconChevronDown, IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { activeTurnIndex, turnsOf, windowStart, type Turn } from "../../lib/turns";
import {
  buildProcessRows,
  hiddenReplyIds,
  isProcessItem,
  replyCopy,
  replyDividerIds,
  turnSpans,
  type ProcessEntry,
  type TurnSpan,
} from "../../lib/process";
import { useCollapseTiming, useFoldedReplies, useProcessView, type CollapseTiming } from "../../lib/viewMode";
import { ScrollFollow, useFollowGrowth } from "../../lib/scrollFollow";
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
 * 「算贴底」的容差（px）。
 *
 * 以前是 2px：滚到距底 3px 停下就再也恢复不了跟随，而用户明明觉得已经到底了——
 * 触屏惯性、亚像素误差、以及一圈圆角都会留下几个像素。24px 小于一行正文，
 * 不会把「停在倒数第二行读」误判成贴底（与 DSH 的 FOLLOW_THRESHOLD 同一量级）。
 */
const BOTTOM_SLOP = 24;
/**
 * 浏览器支不支持原生 `scrollend`，**每次现问**（不缓存成模块级常量）。
 *
 * 有它就用它收尾（惯性滚动真停下时才发），没有才退回 150ms 定时器。
 *
 * 支持情况（2026-11 实测 caniuse）：Chrome / Edge 114+、Firefox 109+、
 * **Android System WebView 114+**（由 Play 独立更新，实际设备都远超这条线）。
 * 真正缺的是 **Safari / iOS**：`scrollend` 到 26.2 才支持，而 iOS 的 WKWebView 版本
 * 锁死在系统版本上，用户不升系统就拿不到——所以退化路径**必须留着**。
 *
 * 为什么不缓存：**jsdom 声称支持**（`'onscrollend' in window` 为 true）却从不派发
 * 事件，测试要在加载之后把它抹掉；缓存成模块级常量的话，import 那一刻就定死了，
 * 测试改不动（踩过一次：一个「收起后保位」的用例因为收尾永远不发生而挂）。
 * 运行期读一次属性可以忽略不计。
 */
function supportsScrollEnd(): boolean {
  if (typeof window === "undefined") return false;
  if ((globalThis as { __ccwebNoScrollEnd?: boolean }).__ccwebNoScrollEnd) return false;
  return "onscrollend" in window;
}
/**
 * 键盘上「读者在翻这段对话」的键。
 *
 * 与 DSH 的 `SCROLL_KEYS` 同一份名单：方向键、翻页、首尾、空格。别的键（打字、
 * 快捷键）不算阅读手势——尤其是焦点还在输入框里的时候。
 */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/**
 * 离屏跳过布局/绘制**只给密集的单行过程行**：它们的高度稳定在一行（~28px），32px 的
 * 占位与真实值几乎一致，滚动过程中不会来回回缩。
 *
 * **正文气泡与卡片不要加**（原来那份 `contain-intrinsic-size: auto 120px` 已删）。一条
 * 回答可能是 60px，也可能是一张 2000px 的代码块或表格，估算必然差很远；估算被真实高度
 * 替换时滚动高度会变、滚动位置跟着跳，而且新进入视口的那一行得在**滚动帧里**现算布局
 * ——表现就是「滚起来上下的消息慢半拍」。条数窗口（`VISIBLE_STEP`）已经把 DOM 压住了，
 * 气泡这边交给浏览器自己的离屏绘制跳过。
 */
const OFFSCREEN_ROW = { contentVisibility: "auto", containIntrinsicSize: "auto 32px" } as const;

/**
 * 一条过程行 / 一组过程里包含的「已作答提问」。
 *
 * 提问要**两层都画**（对齐 DSH 的 `QuestionToolRow` + `question-reply`）：过程里留一步
 * 「提问 · 已回答」（点开是完整选项卡片），正文流里再挂一枚问答气泡。气泡不算过程，
 * 所以它挂在**过程块之外**——整轮收起、或者简洁档把组折起来时，步骤跟着藏，
 * 气泡照样看得见（那是用户说的话，不是过程）。
 */
function repliedAsks(entry: ProcessEntry): ToolItem[] {
  if (entry.type === "process") return entry.items.filter(isAnsweredAsk);
  if (entry.type === "item" && entry.item.kind === "tool" && isAnsweredAsk(entry.item)) {
    return [entry.item];
  }
  return [];
}

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
  /**
   * 只有紧凑过程行才挂 `content-visibility: auto`，而且它们**不挂入场动画**。
   *
   * 正文气泡 / 完整卡片的高度是**不可估**的（一行字 vs 一张两千像素的代码块），
   * 加离屏跳过等于让浏览器在「这一行进入视口的那一帧」现算布局与绘制——正好落在
   * 滚动帧上，用户看到的就是「滚一下，内容慢半拍才跟上来」。
   *
   * 紧凑行高度稳定（一行 ~28px），可以留离屏跳过；但**不能同时挂 `animate-rise`**：
   * 被跳过的内容不做样式与布局，入场动画实际是等这一行「变得相关」时才从头播的
   * （`rise-in` 从 `opacity: 0` 起），于是每滚过一屏过程行就重放一遍淡入。
   * 这是「上下消息慢半拍」最直观的来源，去掉后滚动立刻顺畅（实测）。
   * 入场动画只留给挂载时就在的那批（历史回放、新消息追加），滚动经过时不该再演一次。
   */
  const box = (dense: boolean) => ({
    className: offscreen === false || !dense ? "animate-rise" : undefined,
    style: offscreen === false || !dense ? undefined : OFFSCREEN_ROW,
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
          <ThinkingBlock text={item.text} dense={dense} streaming={item.streaming} />
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
        <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
          {item.text}
        </pre>
      );
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
          <IconAlert size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</span>
        </div>
      );
    default:
      return null;
  }
});

/**
 * 一整屏消息行。
 *
 * **单独 memo 出来是为了让滚动帧不碰它**：`onScroll` 里 `setAtBottom` / `setActiveTurn`
 * 每次都会让 `MessageList` 重渲染，而重渲染就会把 `spans.map` 里几百个 React 元素从头
 * 建一遍（`MessageRow` 自己 memo 只能省掉子组件，省不掉外层这些 div 与 props 对象）。
 * 一次滚动几十帧、每帧重建几百个元素，就是「滚起来上下的消息慢半拍」。
 *
 * 这里的 props 在滚动时**全是稳定的引用**（都是 useMemo / useState 出来的）：
 * 行内容只在消息变化、窗口展开、折叠状态变化时才重算。
 */
const TurnRows = memo(function TurnRows({
  spans,
  shown,
  rows,
  copies,
  hiddenReplies,
  dividers,
  dense,
  manual,
  timing,
  onToggleTurn,
}: {
  spans: TurnSpan[];
  shown: Item[];
  rows: ProcessEntry[][];
  copies: Map<string, string>;
  hiddenReplies: Set<string> | null;
  /** 每轮里「前面要加一条分隔线」的正文 item id（见 `replyDividerIds`）。 */
  dividers: Set<string>[];
  dense: boolean;
  manual: Record<string, boolean>;
  timing: CollapseTiming;
  onToggleTurn: (key: string, collapsed: boolean) => void;
}) {

  /** 某一轮此刻是不是收起态。 */
  const isCollapsed = (span: TurnSpan, index: number): boolean => {
    if (span.process.length === 0) return false; // 没有过程可收：纯问答不该多一行
    if (!span.finished) return false; // 还在跑：过程必须看得见
    const touched = manual[shown[span.start].id];
    if (touched !== undefined) return !touched;
    return !(timing === "onNextSend" && index === spans.length - 1);
  };

  return (
    <div className={dense ? "" : "space-y-5"}>
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
            outcome={span.outcome}
            open={!collapsed}
            onToggle={() => onToggleTurn(shown[span.start].id, collapsed)}
          />
        );
        // 只有窗口截断把用户消息切掉时，第一行才不是用户消息：那种情况放在最前面。
        const head = turnRows[0];
        const headIsUser = head?.type === "item" && head.item.kind === "user";
        return (
          <Fragment key={shown[span.start].id}>
            {!headIsUser && collapseRow}
            {turnRows.map((entry, rowIndex) => {
              // 已经答完的提问：气泡挂在过程块之外，收起 / 折组都不影响它。
              const asks = repliedAsks(entry);
              const askBubbles = asks.length > 0 && (
                <div className="space-y-2 pt-2">
                  {asks.map((item) => (
                    <div key={`ask-${item.id}`} className="animate-rise">
                      <AskReplyBubble item={item} />
                    </div>
                  ))}
                </div>
              );
              // 过程收起来了：整批跳过，只留正文。正文与用户消息是「结果」，
              // 收起要藏的只有过程（思考与工具调用）——但问答气泡不是过程，留下。
              if (collapsed && entryTouchesProcess(entry)) {
                return askBubbles ? <Fragment key={entry.key}>{askBubbles}</Fragment> : null;
              }
              // 「仅最终回答」：阶段回复整行跳过，不缩成一行占位。
              if (entry.type === "item" && hiddenReplies?.has(entry.item.id)) return null;
              let row: ReactNode = null;
              if (entry.type === "process") {
                row = (
                  <div
                    key={entry.key}
                    className={dense ? "mt-1" : undefined}
                    // 组根也带一份 id 清单：组收起时子行根本没有 DOM，轨迹里点那一步
                    // 至少要落在这个组头上（「这一步在这里面」），而不是退到轮头——
                    // 那看起来像点错了。展开时子行各自的 `data-item-id` 会先命中。
                    data-item-ids={entry.items.map((item) => item.id).join(" ")}
                  >
                    <ProcessGroup items={entry.items}>
                      {entry.items.map((item) => (
                        <div key={item.id} data-item-id={item.id}>
                          <MessageRow item={item} dense={dense} offscreen={false} />
                        </div>
                      ))}
                    </ProcessGroup>
                  </div>
                );
              } else if (entry.type === "thinking") {
                // 连续的思考块合成一行：**只要其中任意一块还在流，整行就算在流**
                // （CLI 一次思考常被拆成好几块，流式期间最后一块在长）。
                row = (
                  <div key={entry.key} className={dense ? "mt-1" : undefined} data-item-ids={entry.items.map((it) => it.id).join(" ")}>
                    <ThinkingBlock
                      text={entry.items.map((it) => it.text).join("\n\n")}
                      dense={dense}
                      streaming={entry.items.some((it) => it.streaming === true)}
                    />
                  </div>
                );
              } else {
                // 分隔线：过渡正文 → 过程 → 最终回答之间的一道视觉边界。
                // 只在这一段正文确实跨过了过程时才加（见 `replyDividerIds`），
                // 否则相邻两段正文中间会凭空多一道线，像另起了一轮。
                // **用主题色**：它和上面「已完成」下面那条是同一类边界（过程 /
                // 结论的分界），灰色细线在正文里几乎看不见，读起来像排版失误。
                const divider =
                  entry.item.kind === "assistant" && dividers[index]?.has(entry.item.id);
                row = (
                  <div
                    key={entry.key}
                    data-item-id={entry.item.id}
                    className={[
                      dense ? (isProcessItem(entry.item) ? "mt-1" : "mt-5") : "",
                      divider ? "border-t border-brand/60 pt-3" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined}
                  >
                    <MessageRow
                      item={entry.item}
                      dense={dense}
                      copyText={entry.item.kind === "assistant" ? copies.get(entry.item.id) : undefined}
                    />
                  </div>
                );
              }
              // 气泡挂在过程块**之后**：步骤在上（「提问 · 已回答」），我的回答在下。
              // 不挂进 `ProcessGroup` 的展开体里——组一折起来气泡就跟着没了。
              const content = askBubbles ? (
                <>
                  {row}
                  {askBubbles}
                </>
              ) : (
                row
              );
              if (rowIndex === 0 && headIsUser) {
                return (
                  <Fragment key={entry.key}>
                    {content}
                    {collapseRow}
                  </Fragment>
                );
              }
              return <Fragment key={entry.key}>{content}</Fragment>;
            })}
          </Fragment>
        );
      })}
    </div>
  );
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
  /**
   * 贴底跟随的意图与归因（见 `lib/scrollFollow`）：往上翻就停、回到底部恢复。
   *
   * 不用「上一次 scroll 的位置」判方向：内容变短（收起过程）、输入框聚焦、
   * 浏览器自己的 scroll anchoring 都会产生朝上的位移，但它们不是读者在往上滚。
   */
  const [follow] = useState(() => new ScrollFollow(true, BOTTOM_SLOP));
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
  /**
   * 读者视线钉住的那一行（`data-item-id` + 它相对滚动区顶部的偏移）。
   *
   * 为什么不是「距底部多远」：加载更早、收起一轮的过程都会改变内容高度，而距底距离
   * 把「视口上方长了多少」与「下方短了多少」混成一个数；历史里有图片、代码块延迟
   * 撑高时它会漂。按一行真实元素钉，位置由那一行自己给出（与 DSH 的
   * `capturePosition` 同一思路）。
   */
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  /** 上一次 commit 的内容高度：用来发现「内容变短了」（收起过程 / 折叠卡片）。 */
  const lastHeight = useRef(0);
  /** 上一次的窗口大小：变大 = 刚点了「加载更早」，要按锚点还原。 */
  const prevLimit = useRef(VISIBLE_STEP);
  /** 上一次 commit 的结构签名：只有结构变了才值得重算锚点（流式纯内容增长不算）。 */
  const prevStruct = useRef<{
    count: number;
    manual: Record<string, boolean>;
    timing: CollapseTiming;
    running: boolean;
    dense: boolean;
    hidden: number;
  } | null>(null);
  /**
   * 手指/鼠标按住滚动区的状态。
   *
   * 手机上长按选文本、按住屏幕读一段话时内容还在流式增长；跟随会在手指底下继续把
   * 内容往上推，选中直接跑掉。按住期间**暂停所有贴底写入**（三条守卫全读它，
   * 见 `follow.pin` 的三处调用），松手时再按落点结算。
   *
   * **它必须活到 `touchend`，不能被 `pointercancel` 收掉**：触摸滚动一开始（以及
   * 长按选择手势）浏览器就发 `pointercancel`，此后不再有 `pointerup`。把它当松手的话
   * `press` 立刻变成 null，于是整个滚动过程中 `pin` 每帧都在跑——手指每滑几像素就被
   * 写回底部，`onScroll` 的归因又因为「已经在容差内」把 `following` 判回 true，
   * 越滚越回底，只有一帧滑过 24px 才滚得动（截图复现过）。滚轮没有这个问题，
   * 它一滚就是几十像素且直接 `release()`。
   *
   * `touch` 记「这次是按在触屏上」：只有触屏才需要等 `touchend`，鼠标/笔继续按
   * `pointerup` 结算（否则鼠标拖选文本也要等一个永远不会来的 `touchend`）。
   */
  const press = useRef<{
    following: boolean;
    moved: boolean;
    y: number;
    top: number;
    /** 触屏手势：松手信号是 `touchend`/`touchcancel`，不是 pointer 事件。 */
    touch: boolean;
  } | null>(null);
  /** 触摸手势的兜底超时：`touchend` 万一没来（WebView 吞事件），别让跟随永久暂停。 */
  const pressTimer = useRef<number | null>(null);
  /** 轮次刻度：每条用户消息一个刻度，点一下跳到那一轮。 */
  const turns = useMemo(() => turnsOf(items), [items]);
  const [activeTurn, setActiveTurn] = useState(0);
  const rafPending = useRef<number | null>(null);
  /** 滚动停止计时器：停止后重量一次几何，兜住「上方内容高度变化」的情况。 */
  const scrollSettle = useRef<number | null>(null);
  /**
   * 待执行的跳转：目标可能被「最近 N 条」窗口截掉、或被收起的轮挡住。
   *
   * `fallback` 是这一轮的轮头（用户消息）：目标被「仅最终回答」藏掉时至少落在同一轮里，
   * 不至于点了毫无反应。`tries` 防止每次流式追加都重试一次滚动。
   */
  const pendingJump = useRef<{ id: string; fallback?: string; tries: number } | null>(null);

  /**
   * 记下此刻视口顶部那一行，供「内容变短 / 展开更早」之后把视线钉回去。
   *
   * 行按文档顺序排列、底边单调递增，所以二分找第一个越过视口顶部的行：每帧 commit
   * 都可能调一次，不能线性扫一遍再逐个读几何。
   */
  const captureAnchor = () => {
    const sc = scroller.current;
    if (!sc) return;
    const top = sc.getBoundingClientRect().top;
    const rows = sc.querySelectorAll<HTMLElement>("[data-item-id]");
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (rows.item(mid).getBoundingClientRect().bottom > top + 1) high = mid;
      else low = mid + 1;
    }
    const row = rows.item(low);
    const id = row?.dataset.itemId;
    anchor.current = row && id ? { id, offset: row.getBoundingClientRect().top - top } : null;
  };

  /** 把锚点那一行放回原来的屏幕位置；行已经不在了（被收起）就什么都不做。 */
  const restoreAnchor = () => {
    const sc = scroller.current;
    const a = anchor.current;
    if (!sc || !a) return;
    const row =
      sc.querySelector<HTMLElement>(`[data-item-id="${a.id}"]`) ??
      sc.querySelector<HTMLElement>(`[data-item-ids~="${a.id}"]`);
    if (!row) return;
    const rel = row.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    sc.scrollTop += rel - a.offset;
    // 这次写入是我们做的：登记成新基准，别让它在下一次 scroll 事件里被算成读者移动。
    follow.reset(sc.scrollTop);
  };

  const scrollToItem = (id: string): boolean => {
    const sc = scroller.current;
    // `data-item-id` 是单条；`data-item-ids` 是「几块合成一行」的容器（连续的思考块合并
    // 成一块渲染），轨迹里点某一步时两处都要找得到。
    const el =
      sc?.querySelector<HTMLElement>(`[data-item-id="${id}"]`) ??
      sc?.querySelector<HTMLElement>(`[data-item-ids~="${id}"]`);
    if (!sc || !el) return false;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 8;
    /**
     * 跳转的语义就是「我要看这一条」，所以从这一刻起不再贴底跟随。
     *
     * 不解除的话，下一帧流式内容长高（或一次尺寸变化）会立刻把视口拽回底部——用户
     * 在右侧栏轨迹里点某一步，看到的是「跳过去闪一下又弹回最新」。目标本身就在底部
     * 附近时不解除（那是「回到最新」的同义操作）。
     */
    const floor = Math.max(0, sc.scrollHeight - sc.clientHeight);
    if (Math.abs(floor - top) > BOTTOM_SLOP) follow.release();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (!reduce && typeof sc.scrollTo === "function") sc.scrollTo({ top, behavior: "smooth" });
    else follow.jump(sc, top);
    return true;
  };

  const jumpToTurn = (turn: Turn) => {
    const need = items.length - turn.index;
    if (need > limit) {
      pendingJump.current = { id: turn.id, tries: 0 };
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
   * 每轮里哪些正文段前面要加分隔线（过渡正文 → 过程 → 最终回答）。
   *
   * 与 `hiddenReplies` 一起算：被「仅最终回答」藏掉的那些回复不占渲染位置，
   * 不该参与分段，否则会给真正的那一段多挂一条看不见前文的线。
   *
   * **没结束的轮不画**（`span.finished`）：跑到一半时最后一段正文只是「说到哪」，
   * 模型还会接着说。按它画线，线就先挂在过渡正文上、之后又跳到结论前面——
   * 思考过程上方那道横线就是这么来的。最终回答只在一轮收尾之后才成立。
   *
   * 要在 `spans` 之后定义（按轮切片）。
   */
  const spans = useMemo(() => turnSpans(shown, running), [shown, running]);
  const dividers = useMemo(
    () =>
      spans.map((span) =>
        replyDividerIds(shown.slice(span.start, span.end), hiddenReplies ?? undefined, span.finished),
      ),
    [spans, shown, hiddenReplies],
  );
  const [manual, setManual] = useState<Record<string, boolean>>({});
  /**
   * 右侧栏轨迹面板点某一步 → 滚到对话里的那一条。
   *
   * 除了「滚过去」还要做两件事，否则点击看起来毫无反应：
   *   ① 目标所在的轮如果是收起的，先把它展开——收起的那一整段过程根本没有 DOM 节点；
   *   ② 目标被「最近 N 条」窗口截掉时把窗口扩到够。
   * 真正的滚动交给下面 `pendingJump` 那条 layout effect（要等这批 state 落到 DOM 上）。
   */
  const scrollRequest = useAppStore((s) => s.scrollRequest);
  const handledScroll = useRef(0);
  /** 只为「让 layout effect 再跑一次」：目标本来就在窗口里时没有别的 state 会变。 */
  const [jumpTick, setJumpTick] = useState(0);
  useEffect(() => {
    const req = scrollRequest;
    if (!req || req.seq <= handledScroll.current) return;
    handledScroll.current = req.seq;
    const index = items.findIndex((it) => it.id === req.itemId);
    if (index < 0) return;
    // 这一轮的轮头（用户消息）：没有它就没法展开被收起的轮。
    const head = [...turns].reverse().find((tn) => tn.index <= index);
    if (head) setManual((prev) => (prev[head.id] ? prev : { ...prev, [head.id]: true }));
    pendingJump.current = { id: req.itemId, fallback: head?.id, tries: 0 };
    const need = items.length - index;
    if (need > limit) setLimit(need);
    setJumpTick((n) => n + 1);
    // 只认 seq：items / limit / turns 的每一次变化都要重跑的话，流式输出期间会反复跳。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  /**
   * 手动开合某一轮的过程。
   *
   * **必须 useCallback**：它要作为 `TurnRows` 的 prop，每次渲染新建一个函数会让那个
   * memo 失效，滚动帧照样重建整棵树。
   */
  const toggleTurn = useCallback((key: string, collapsed: boolean) => {
    // `manual` 记的是「用户要它展开吗」：点一下就是取反当前的收起态。
    setManual((prev) => ({ ...prev, [key]: collapsed }));
  }, []);
  /**
   * 每轮各自成行：分组只在轮内发生，跨轮的分组没有意义。
   *
   * 不再把 `row.start` 平移成「在整份 `shown` 里的下标」——那个字段没有任何消费方
   * （轮级收起重构之后，定位一律走 `data-item-id` 与 `span.start`）。每行多复制一个
   * 对象、每轮多一次 `slice` 平移，在流式输出时是白付的。
   */
  const rows = useMemo(
    () => spans.map((span) => buildProcessRows(shown.slice(span.start, span.end), grouping)),
    [spans, shown, grouping],
  );
  /**
   * 每条回答该复制的整轮正文（`lib/process.replyCopy`）：只有本轮最终回答拿得到值，
   * 过渡正文拿不到——它们也就不用渲染复制按钮。
   *
   * **这一轮没结束就一个都不给**：跑到一半时「最后一条正文」只是半句话，挂个复制按钮
   * 既没意义，又会在过程里冒出来（用户看到的就是「思考过程下面多了一个复制按钮」）。
   *
   * **每轮只问一条**：`replyCopy` 只会给「本轮最后一条有正文的回答」返回值，所以从后
   * 往前找到第一条够格的再问就行。以前是对轮内每条 assistant 都调一次（每次都把整轮
   * 扫一遍），流式输出时每个 token 都要重算一遍整份 `shown`，一轮两百条就是四万次比较
   * ——那是「边输出边滚动最卡」的来源之一。
   */
  const copies = useMemo(() => {
    const map = new Map<string, string>();
    for (const span of spans) {
      if (!span.finished) continue;
      const slice = shown.slice(span.start, span.end);
      // 从后往前跳过「不算正文」的条目，与 `replyCopy` 自己的过滤口径一致。
      for (let i = slice.length - 1; i >= 0; i -= 1) {
        const item = slice[i];
        if (item.kind !== "assistant" || item.apiError || !item.text.trim()) continue;
        const text = replyCopy(slice, item.id, true);
        if (text !== undefined) map.set(item.id, text);
        break;
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
      // **一次查询建表**：以前每一轮调一次 `querySelector`（每轮都在整棵子树上扫一遍），
      // 几百轮的会话每次滚动停止都要扫几百遍。只要每轮的锚点（用户消息），先收成一个
      // Set，扫一遍 DOM 就够。
      const wanted = new Set(turns.map((turn) => turn.id));
      const found = new Map<string, HTMLElement>();
      for (const el of sc.querySelectorAll<HTMLElement>("[data-item-id]")) {
        const id = el.dataset.itemId;
        if (id !== undefined && wanted.has(id)) found.set(id, el);
      }
      const origin = sc.getBoundingClientRect().top - sc.scrollTop;
      turnTops.current = turns.map((turn) => {
        if (turn.index < hidden) return Number.NEGATIVE_INFINITY;
        const el = found.get(turn.id);
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
    setActiveTurn(activeTurnIndex(turnTops.current, sc.scrollTop, undefined, follow.following));
    // `follow` 是 useState 出来的稳定实例，不必进依赖。
  }, [follow]);

  /**
   * 首次挂载与切换对话：**在绘制前**就贴到底。
   *
   * 以前这一步排在一个 rAF 里（`useEffect` 之后），长对话的表现是「先画出中间一段，
   * 下一帧再跳到底部」——闪一下。layout 阶段写 `scrollTop` 虽然会触发一次同步布局，
   * 但那次布局本来就要为这批新节点做。
   *
   * 必须先于下面的「内容变化」effect 声明：切对话要把跟随复位成 true，再让它去贴底。
   */
  useLayoutEffect(() => {
    setLimit(VISIBLE_STEP);
    follow.resume();
    setAtBottom(true);
    setUnseen(false);
    prevCount.current = items.length;
    prevLimit.current = VISIBLE_STEP;
    // 换对话：新会话的第一条 user 不是「刚发的」，别在挂载时额外触发一次强制贴底。
    lastUserSent.current = items[items.length - 1]?.kind === "user" ? items[items.length - 1].id : null;
    const el = scroller.current;
    if (el) {
      follow.pin(el);
      lastHeight.current = el.scrollHeight;
      anchor.current = null;
    }
    // 只认 resetKey：首次挂载与切对话各跑一次，items 变化不该重跑（那会反复贴底）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

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
        if (follow.following && press.current === null) {
          // 几何变了不是「读者移动」，不要拿它去改跟随意图（那是 `ScrollFollow`
          // 在 scroll 事件里按归因结算的事）。这里**不做**「已经在底部就跳过」的
          // 优化：这次回调的触发原因就是几何变了，此刻的 scrollHeight/scrollTop
          // 恰好在旧值上自洽（视口变矮时差值是正的、变高时也可能是 0），按它们判断
          // 会跳过写入，滚动位置就此停在离底部更远的地方。
          follow.pin(sc);
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

  /**
   * 每次 commit 后决定「视口该在哪」。这是滚动策略的全部分支，三件事按顺序判：
   *
   *   1. **读者自己发了一条** → 无条件回到底部并恢复跟随（他在往上翻着读历史时发消息，
   *      刚发的气泡和后面的回复全在视口外，看起来像「发了没反应」）。`echoed` 的除外：
   *      那是别的设备/标签发的，不能把正在读历史的人拽回底部。
   *   2. **跟随中** → 钉到底部。内容变高（流式追加、图片加载、展开折叠块）也好，
   *      视口变矮（审批卡片、计时行）也好，都在这里跟上。
   *   3. **不跟随** → 内容**变短**（一轮结束收起过程、折叠卡片）或**刚展开更早的消息**时，
   *      按锚点把读者视线钉回原位；否则只刷新锚点。
   *
   * 写在 layout 阶段而不是 `useEffect` + `rAF`：长对话首次打开要先画出中段再跳到底，
   * 那一下就闪在用户眼前；流式输出也会慢一帧。
   */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const grew = items.length > prevCount.current;
    prevCount.current = items.length;

    const tail = items[items.length - 1];
    const sentNow = tail?.kind === "user" && !tail.echoed && tail.id !== lastUserSent.current;
    if (tail?.kind === "user") lastUserSent.current = tail.id;
    if (sentNow) {
      follow.resume();
      follow.pin(el);
      setAtBottom(true);
      setUnseen(false);
      lastHeight.current = el.scrollHeight;
      anchor.current = null;
      return;
    }

    const height = el.scrollHeight;
    const shrunk = lastHeight.current - height;
    // 窗口只会在「加载更早」时变大；切对话会把它复位成 `VISIBLE_STEP`（变小），
    // 那不是展开，别按锚点还原（那时锚点本来就是空的）。
    const openedEarlier = limit > prevLimit.current;
    prevLimit.current = limit;
    lastHeight.current = height;

    /**
     * **刚展开了更早的消息**：读者点的是「加载更早」，意思是「我要往上读」，所以
     * 既不能把视口钉到底部（刚展开的内容全在视口上方，钉底就什么也看不到），也不能
     * 继续跟随（接下来的新内容不该把他拽回来）。按展开前记下的那一行保持位置。
     */
    if (openedEarlier) {
      follow.release();
      setAtBottom(false);
      restoreAnchor();
      captureAnchor();
      return;
    }

    if (follow.following) {
      // 按住屏幕期间不要推内容（见 `press`）：跟随意图还在，只是先不动。
      if (press.current !== null) return;
      follow.pin(el);
      setAtBottom(true);
      setUnseen(false);
      anchor.current = null;
      return;
    }

    if (grew) setUnseen(true);
    // 纯内容增长（流式追加同一个气泡）不改结构，锚点也不会变：只有结构变了、
    // 或者内容真的变短了才值得读一遍几何。否则用户在读历史时，流式输出的每一帧
    // 都要做一次全树查询 + 二分读 rect。
    const ps = prevStruct.current;
    const structural =
      ps === null ||
      ps.count !== items.length ||
      ps.manual !== manual ||
      ps.timing !== timing ||
      ps.running !== running ||
      ps.dense !== dense ||
      ps.hidden !== hidden;
    prevStruct.current = { count: items.length, manual, timing, running, dense, hidden };
    if (structural || shrunk > 0) {
      if (openedEarlier || shrunk > 0) restoreAnchor();
      captureAnchor();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hidden, limit, manual, timing, running, dense]);

  // 内容变高（展开思考过程 / 工具卡片、图片加载完、流式追加一段）也跟随贴底。
  //
  // 上面那个 effect 只认条数变化：展开一个折叠块不改 items，新露出来的正文就留在
  // 视口外，点开像没反应。这里按内容容器的高度变化补上，规则与滚动本身一致——
  // 用户往上滚过（不贴底）就不跟，滚回底部自然恢复，不额外给状态。
  useFollowGrowth(
    scroller,
    content,
    () => follow.following && press.current === null,
    true,
    // 落点要登记成归因基准，否则下一次 scroll 事件会拿旧基准去比。
    (el) => follow.pin(el),
  );

  // 展开更早的消息后把视口钉在原来那条消息上，别让它「跳一下」。
  // 顺手把挂起的跳转走完：目标可能在窗口外（limit 变了）、也可能在刚被展开的轮里
  // （manual 变了）——两个依赖缺一不可，否则「点轨迹里那一步」会停在没滚动的状态。
  useLayoutEffect(() => {
    const jump = pendingJump.current;
    if (!jump) return;
    jump.tries += 1;
    if (scrollToItem(jump.id)) {
      pendingJump.current = null;
      return;
    }
    // 第一次没找到通常是因为同一批 state（展开这一轮 / 扩大窗口）还没落到 DOM 上，
    // 给一次重试；再找不到就退到轮头，别一直重试到流式输出的每一帧。
    if (jump.tries >= 2 && jump.fallback && jump.fallback !== jump.id && scrollToItem(jump.fallback)) {
      pendingJump.current = null;
      return;
    }
    if (jump.tries >= 3) pendingJump.current = null;
  }, [limit, manual, items, spans, jumpTick]);

  // 滚动停止后重量一次：折叠/展开卡片、图片加载完成都会让上面的高度变化，
  // 而轮次签名没变、缓存不会自动失效。趁用户没在滚（也没有布局竞争）时补一次。
  useEffect(() => {
    return () => {
      if (scrollSettle.current !== null) window.clearTimeout(scrollSettle.current);
      // 卸载时把触摸兜底计时器一起收掉，别让它在已卸载的组件上 setState。
      if (pressTimer.current !== null) {
        window.clearTimeout(pressTimer.current);
        pressTimer.current = null;
      }
    };
  }, []);

  /**
   * 滚动停下来之后要做的收尾：重量几何、同步轮次刻度、刷新锚点。
   *
   * 它由 `scrollend` 触发；浏览器没有 `scrollend` 时退回 150ms 定时器（见 `onScroll`）。
   */
  const settleScroll = useCallback(() => {
    if (scrollSettle.current !== null) {
      window.clearTimeout(scrollSettle.current);
      scrollSettle.current = null;
    }
    measureTurns(true);
    syncActiveTurn();
    // 停手后刷新锚点：下一次「收起过程」要靠它把视线钉住。
    if (!follow.following) captureAnchor();
  }, [measureTurns, syncActiveTurn, follow]);

  /**
   * 一次 scroll 事件 = 一次位置变化，按它结算跟随意图。
   *
   * 归因在 `ScrollFollow.read` 里：只有「相对上一次确认的位置真的动了」才算是读者
   * 移动。内容变短被浏览器 clamp、输入框聚焦挪动、原生 scroll anchoring 补偿……
   * 这些朝上的位移都不会把跟随关掉（详见 `lib/scrollFollow`）。
   */
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const { metrics, movedByReader } = follow.read(el);
    // 有 `scrollend` 就交给它收尾（它比定时器准：惯性滚动期间 150ms 可能不够，
    // 中途"补"一次会把还没停的滚动当成停手）。没有才退回定时器。
    if (!supportsScrollEnd()) {
      if (scrollSettle.current !== null) window.clearTimeout(scrollSettle.current);
      scrollSettle.current = window.setTimeout(settleScroll, 150);
    }
    // 按住屏幕期间不结算：手指没动，跟随也不该在这里被改写（见 `press`）。
    if (press.current === null) follow.sample(metrics, movedByReader);
    // 这两个 setState 在值没变时会被 React 自己挡掉（`Object.is` 相同即跳过重渲染），
    // 不必再手写一层比较。真正会变的是 `syncActiveTurn` 里的 `activeTurn`——它一变
    // `MessageList` 就重渲染，所以行树才要单独 memo 成 `TurnRows`（见那里的注释）。
    setAtBottom(follow.following);
    if (follow.following) setUnseen(false);
    if (rafPending.current === null) {
      rafPending.current = window.requestAnimationFrame(() => {
        rafPending.current = null;
        syncActiveTurn();
      });
    }
  };

  /** 按下：只记住「按下前在不在跟随」与按下时的位置，真正改意图要等松手。 */
  const onPointerDown = (e: ReactPointerEvent) => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    press.current = {
      following: follow.following,
      moved: false,
      y: e.clientY,
      top: e.currentTarget.scrollTop,
      touch: e.pointerType === "touch",
    };
    // 触屏手势的兜底：`touchend` 万一没来（WebView 吞事件 / 手势被系统接管），
    // `press` 挂着就等于跟随永久暂停。
    //
    // **到点只能「放弃跟随」，不能走 endPress 的恢复分支**：endPress 在「没动过 +
    // 按之前是跟随」时会 resume + pin，而 10 秒时手指多半还按在屏幕上（长按选文本、
    // 按住读一段）。把它 pin 回底部正是这次要根除的「每帧被拽回」，只是延后到 10 秒。
    // 真正的松手仍由 touchend 结算。
    if (press.current.touch) {
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        if (!press.current) return;
        press.current = null;
        follow.release();
        setAtBottom(false);
      }, 10_000);
    }
  };

  /** 手指/鼠标移动超过 6px 才算「读者在滚」，否则视为一次点击。 */
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.moved) return;
    if (Math.abs(e.clientY - p.y) > 6) p.moved = true;
  };

  /**
   * 松手：没动过就恢复原来的跟随（并贴回底部），动过就按落点重新判断。
   *
   * 「按住但没滚」恢复跟随是有意的：轻点一下消息（选中、点链接）不该让会话从此不再
   * 跟随最新内容；而按住读的那几秒里内容长高了，松手后回到底部也符合「我在看最新」。
   *
   * 「动过」的判据只有位移（`movedPos`）：触摸滚动全程没有 `pointermove`，
   * `p.moved` 永远是 false，所以滚动了的位置变化必须认。
   *
   * 落点**只有真到底（≤2px）才恢复贴底**，不套 24px 的 `BOTTOM_SLOP`：那个容差是给
   * 「程序化写入后被 clamp」留的余地，用在松手结算上会变成「轻滑十几像素松手就被拽
   * 回底部」，正是这次要根除的手感。不恢复时 `following=false`，右下角出现
   * 「回到底部」；读者自己滚回底部后由 `onScroll` 的归因恢复。
   */
  const endPress = useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    const p = press.current;
    press.current = null;
    const el = scroller.current;
    if (!p || !el) return;
    const { metrics } = follow.read(el);
    const movedPos = Math.abs(metrics.top - p.top) > 2;
    if (!p.moved && !movedPos && p.following) {
      follow.resume();
      follow.pin(el);
      setAtBottom(true);
      setUnseen(false);
      return;
    }
    /**
     * 读者滚过：按落点结算，**只有真的到底才继续跟随**。
     *
     * 这里不调 `follow.sample`：它按 `nearBottom`（24px 容差）判，轻滑十几像素松手
     * 也会被拽回底部——正是这次要根除的手感。那个容差是给「程序化写入被 clamp」
     * 留的余地，不该用在松手结算上。
     */
    if (Math.abs(metrics.floor - metrics.top) <= 2) {
      follow.resume();
      follow.pin(el);
      setAtBottom(true);
      setUnseen(false);
      return;
    }
    follow.release();
    // 把落点登记成新基准：下一次 scroll 事件从这里往上比，才不会把这次结算前的
    // 位移再算一遍读者移动。
    follow.reset(metrics.top);
    setAtBottom(false);
  }, [follow]);

  /**
   * 松手可能发生在滚动区之外（拖出去再松开），也可能根本收不到 `pointerup`。
   * **必须挂到 window 上兜底**：漏一次，`press` 就永远不为 null，跟随再也回不来。
   *
   * **触屏手势认 `touchend`/`touchcancel`，不认 `pointercancel`**：触摸滚动一开始、
   * 以及长按选择手势，浏览器都会发 `pointercancel` 并且**不再补 `pointerup`**，而
   * `touchend` 才是手指真的离开屏幕的时刻。把 `pointercancel` 当松手的话，手指还在
   * 滑的过程中 `press` 就被清掉，三条贴底守卫同时失效——内容每帧被 `pin` 回底部，
   * 手指滚不动（详见 `press` 的注释）。`touchcancel` 是系统收走手势（来电、边缘手势），
   * 那时也要结算，否则 `press` 挂到超时为止。
   *
   * 鼠标/笔仍按 `pointerup` 结算；`blur` 一律结算（窗口被打断，等不到松手了）。
   */
  useEffect(() => {
    const settle = () => {
      if (press.current !== null) endPress();
    };
    /** 触屏手指离开。`pointerup` 也可能随后再来一条，那时 `press` 已被清空，无害。 */
    const touchEnd = () => {
      if (press.current?.touch) endPress();
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("touchend", touchEnd);
    window.addEventListener("touchcancel", touchEnd);
    window.addEventListener("blur", settle);
    return () => {
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
      window.removeEventListener("blur", settle);
    };
  }, [endPress]);

  /**
   * **读者开始操作**就放弃跟随，不等 scroll 事件、也不等位移。
   *
   * 与 DSH 的 `READING_INTENTS` 同一思路（`use-chat-viewport.ts` 的 `onIntent`）：
   * 一次滚轮的位移可能小到落在容差里，那时内容仍会被下一帧的跟随推走；键盘翻页
   * 更是压根没有 pointer 事件。判据必须是「手势本身」，不是它的结果。
   *
   * 这里补的是我们原先缺的两种来源（`wheel` 与 `pointerdown` 早就有各自的处理）：
   *
   *   - **`keydown`**：方向键 / PageUp / PageDown / Home / End / 空格。焦点在输入框里
   *     时不算（那是打字，不是阅读），非滚动键也不算。
   *   - **`beforematch`**：浏览器 Ctrl+F 页内查找命中并滚过去。它会改视口却没有任何
   *     用户手势，不接的话跟随会跟它抢位置。
   *
   * **`keydown` 必须挂 `window`、不能挂滚动区**：滚动区是页面里的一个 div、没有
   * `tabIndex`，焦点很少在它上面——挂在它上面的监听基本不会触发（DSH 能挂在容器上，
   * 是因为它的列表在 `[data-conversation-scroll]` 且整页滚动）。挂 `window` 时用
   * 「焦点在输入框里就跳过」把打字场景排除掉，判据与 DSH 的
   * `target.closest('[data-composer-seat]')` 等价。
   *
   * **`touchstart` 没有单独接**：触屏按下一定先有 `pointerdown`，重复注册只会多一条
   * 无用的路径（DSH 那五路里它对我们也是冗余的）。
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const intent = () => {
      follow.release();
      setAtBottom(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      // 焦点在输入框 / 可编辑区里时不干预：那里按方向键是在移动光标。
      const t = e.target as Element | null;
      if (t && t.closest("input, textarea, [contenteditable='true']")) return;
      intent();
    };
    // `beforematch` 只对滚动区自己派发（查找命中会滚那个容器），就近挂。
    window.addEventListener("keydown", onKey);
    el.addEventListener("beforematch", intent);
    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("beforematch", intent);
    };
  }, [follow]);

  /**
   * 原生 `scrollend`：滚动**真的**停下来时收尾（含惯性）。
   *
   * 比 150ms 定时器准：长惯性滚动超过 150ms 时，定时器会在滚动还没停时"补"一次，
   * 把还在动的时刻当成停手去刷锚点与轮次刻度。没有这个事件时 `onScroll` 里仍走定时器
   * （见 `supportsScrollEnd`）。
   */
  useEffect(() => {
    if (!supportsScrollEnd()) return;
    const el = scroller.current;
    if (!el) return;
    el.addEventListener("scrollend", settleScroll);
    return () => el.removeEventListener("scrollend", settleScroll);
  }, [settleScroll]);

  /**
   * 滚轮往上滚 = 读者要看历史。立刻解除跟随，不等 scroll 事件（一次滚轮的位移
   * 可能小到落在容差里，那样内容仍会被下一帧的跟随推走）。
   *
   * 嵌套滚动区（代码块、工具卡片的命令块）里的滚轮不算：那里横向/纵向滚动的是
   * 卡片自己，读者并没有离开会话底部。
   */
  const onWheel = (e: ReactWheelEvent) => {
    const sc = scroller.current;
    const target = e.target as Element | null;
    // 注意比的是**最近的**那个滚动容器是不是会话滚动区自己：滚轮事件的 target
    // 通常是正文里的某个元素，而它的祖先链上就有消息区（`.dsh-scroll`）。
    // 拿「有没有祖先」当条件的话，页面里的每一次滚轮都会被当成嵌套滚动。
    const nested = target?.closest("pre, .dsh-scroll, .code-scroll");
    if (sc && nested && nested !== sc) return;
    if (e.deltaY >= 0) return;
    follow.release();
    setAtBottom(false);
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    follow.resume();
    setAtBottom(true);
    setUnseen(false);
    /**
     * **不写 smooth**：这条路径要跨过的可能是整段历史（几百条消息），平滑动画要跑好几秒；
     * 而流式输出每帧都在长高，跟随（即时定位）会在动画途中直接改写 `scrollTop`，把动画
     * 打断成一次瞬移——用户看到的是「点了回到底部，滚到一半卡住」。这颗按钮的语义是
     * 「立刻回到最新」，即时定位才是它该有的手感。跳转某一条（`scrollToItem`）仍用 smooth。
     */
    follow.pin(el);
  };

  const loadEarlier = () => {
    // 展开更早的消息会把视口上方整段变高：先把视线所在的那一行记下来，
    // 展开后由「内容变化」那个 layout effect 按它还原。
    captureAnchor();
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
        // `overflow-x-hidden` **不能省**：只写 `overflow-y-auto` 时，按 CSS 规则另一轴的
        // `visible` 会被算成 `auto`——消息区其实一直是横向滚动容器。一条不含断点的长
        // 文件名 / 长路径（工具的 file_path、用户贴的路径）就能把它推出去，手机上表现为
        // 「整屏内容左右滑动、两边都被裁掉」（截图复现过）。
        // 内容本身仍然要能显示：正文走 `[overflow-wrap:anywhere]` 折行，代码块与表格
        // 各自是内部横向滚动容器（见 `common/Markdown`），所以这里裁掉的是真正的
        // 溢出，不是内容。
        // `dsh-chat-scroll` 关掉浏览器的 scroll anchoring：它会在内容变化时偷偷改
        // `scrollTop`，和我们的贴底跟随抢同一个值（见 `styles.css` 那条注释）。
        className={`dsh-scroll dsh-chat-scroll h-full overflow-x-hidden overflow-y-auto ${turns.length >= 2 ? "dsh-scroll-none-md" : ""}`}
        onScroll={onScroll}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <div
          ref={content}
          // 上下内边距分开写：下方贴着输入区，`py-8` 的 32px 加上末尾的 spacer
          // 会叠出一大片空白（底部跟随之后那片空白更显眼）。
          // `min-w-0`：父级是块级，本来不会撑宽，但这里显式拦住「子元素按 min-content
          // 撑开」这条路，与上面那条 overflow-x-hidden 一起构成围栏。
          className={`mx-auto w-full min-w-0 max-w-[820px] px-4 pb-2 pt-6 md:px-6 md:pb-3 md:pt-8 ${turns.length >= 2 ? "md:pr-10" : ""}`}
        >
          {/*
            「加载更早」按钮与消息行之间那 20px 间距原来由**同一个** `space-y-5` 容器提供
            （容器里放的是按钮和每一轮的 Fragment）。行树抽成 `TurnRows` 之后它自己是一个
            兄弟节点，所以这一层容器要留着：`space-y-5` 只作用于直接子元素，套在按钮自己
            身上是无效的（它只有一个子元素）。`TurnRows` 内部还有一层，负责轮与轮之间的
            间距——两层各管一段，缺一层就会有一处贴在一起。
          */}
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
            <TurnRows
              spans={spans}
              shown={shown}
              rows={rows}
              copies={copies}
              hiddenReplies={hiddenReplies}
              dividers={dividers}
              dense={dense}
              manual={manual}
              timing={timing}
              onToggleTurn={toggleTurn}
            />
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
          // 不用 `backdrop-blur`：它下面的内容正在滚，模糊得每帧重算一遍，而且覆盖的
          // 是一整块滚动区域——这是滚动手感变钝的典型来源。底色本来就接近不透明，
          // 视觉上没有可感知的差别。
          className="absolute bottom-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-line-strong bg-canvas/95 text-ink shadow-soft transition hover:bg-panel-strong"
        >
          <IconChevronDown size={16} />
          {unseen && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand" />}
        </button>
      )}
    </div>
  );
}
