import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Item } from "../../lib/model";
import { AssistantBubble } from "./AssistantBubble";
import { ResultBar } from "./ResultBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { UserBubble } from "./UserBubble";
import { ToolCardHost } from "../tools/ToolCardHost";
import { IconAlert, IconChevronDown, IconSpark } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { activeTurnIndex, turnsOf, type Turn } from "../../lib/turns";

/**
 * 长对话只渲染最近这一批，往上翻时再按批展开。
 *
 * 为什么不是虚拟列表：消息高度差异极大（一行文字 vs 几百行 diff），
 * 自己算高度容易抖；「限制渲染条数 + 离屏跳过布局绘制」足够压住 DOM 规模，
 * 也不会破坏浏览器自带的查找、锚点与无障碍树。
 */
const VISIBLE_STEP = 80;
/** 离屏行不参与布局/绘制；估算高度给滚动条一个稳定长度。 */
const OFFSCREEN = { contentVisibility: "auto", containIntrinsicSize: "auto 120px" } as const;

/**
 * 上一轮结束的 result 条要不要省掉时长：normalize 已经把 duration_ms 回填到
 * 该回合最后一条回答上（复制按钮那一行），这里不再重复一遍。
 */
function durationShownOnAnswer(prev: Item | undefined): boolean {
  return prev?.kind === "assistant" && prev.turn?.durationMs !== undefined;
}

/** 单条消息。memo 化：流式追加时只有最后一个气泡需要重渲染。 */
const MessageRow = memo(function MessageRow({ item, hideDuration = false }: { item: Item; hideDuration?: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <UserBubble text={item.text} ts={item.ts} />
        </div>
      );
    case "assistant":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <AssistantBubble text={item.text} streaming={item.streaming} ts={item.ts} turn={item.turn} />
        </div>
      );
    case "thinking":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <ThinkingBlock text={item.text} />
        </div>
      );
    case "tool":
      return (
        <div className="animate-rise" style={OFFSCREEN}>
          <ToolCardHost item={item} />
        </div>
      );
    case "result":
      return <ResultBar item={item} hideDuration={hideDuration} />;
    case "system":
      return (
        <pre
          style={OFFSCREEN}
          className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-relaxed text-muted"
        >
          {item.text}
        </pre>
      );
    case "error":
      return (
        <div
          style={OFFSCREEN}
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
  /** 贴底跟随：用户往上翻就停下，回到底部再恢复。 */
  const stick = useRef(true);
  const [limit, setLimit] = useState(VISIBLE_STEP);
  const [atBottom, setAtBottom] = useState(true);
  /** 不贴底时来了新内容：按钮上点一个提示点。 */
  const [unseen, setUnseen] = useState(false);
  const prevCount = useRef(items.length);
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

  const hidden = Math.max(0, items.length - limit);
  const shown = hidden > 0 ? items.slice(-limit) : items;

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

  /** 视口顶部落在哪一轮：只读缓存，不碰 DOM。 */
  const syncActiveTurn = useCallback(() => {
    const sc = scroller.current;
    if (!sc || turnTops.current.length === 0) return;
    setActiveTurn(activeTurnIndex(turnTops.current, sc.scrollTop));
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
    const ro = new ResizeObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
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

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const dist = distFromBottom.current;
    if (!stick.current && hidden > 0 && dist !== null) {
      el.scrollTop = el.scrollHeight - dist;
    }
  }, [items.length, hidden]);

  // 滚动停止后重量一次：折叠/展开卡片、图片加载完成都会让上面的高度变化，
  // 而轮次签名没变、缓存不会自动失效。趁用户没在滚（也没有布局竞争）时补一次。
  useEffect(() => {
    return () => {
      if (scrollSettle.current !== null) window.clearTimeout(scrollSettle.current);
    };
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (scrollSettle.current !== null) window.clearTimeout(scrollSettle.current);
    scrollSettle.current = window.setTimeout(() => {
      scrollSettle.current = null;
      measureTurns(true);
      syncActiveTurn();
    }, 150);
    distFromBottom.current = el.scrollHeight - el.scrollTop;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    stick.current = near;
    setAtBottom(near);
    if (near) setUnseen(false);
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
        <div className={`mx-auto w-full max-w-[820px] px-4 py-6 md:px-6 md:py-8 ${turns.length >= 2 ? "md:pr-10" : ""}`}>
          <div className="space-y-5">
            {hidden > 0 && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={loadEarlier}
                  className="rounded-full border border-line-strong bg-canvas px-3 py-1 text-[11.5px] text-muted transition hover:bg-panel-strong hover:text-ink"
                >
                  {t(`加载更早的 ${Math.min(VISIBLE_STEP, hidden)} 条`, `Load ${Math.min(VISIBLE_STEP, hidden)} earlier`)}
                </button>
              </div>
            )}
            {shown.map((item, index) => (
              <div key={item.id} data-item-id={item.id}>
                <MessageRow item={item} hideDuration={durationShownOnAnswer(shown[index - 1])} />
              </div>
            ))}
          </div>
          <div className="h-6" />
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
