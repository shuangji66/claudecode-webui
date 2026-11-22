import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * 一次滚动的几何：当前位置、视口高度、能滚到的最大位置。
 *
 * `floor` 单独算出来是有意的：判断「在不在底部」「这一次位移是谁造成的」都要用它，
 * 而它随时会因为内容增减或视口改高而变。
 */
export interface ScrollMetrics {
  top: number;
  height: number;
  floor: number;
}

export function scrollMetrics(el: HTMLElement): ScrollMetrics {
  const height = el.clientHeight;
  return { top: el.scrollTop, height, floor: Math.max(0, el.scrollHeight - height) };
}

/**
 * 贴底跟随的**意图**，以及「这一次位移是谁造成的」的**归因**。
 *
 * 只按方向判「用户是不是往上滚」会在三个地方翻车，它们长得都像上滚、但都不是：
 *
 *   1. **内容变短**：收起一轮的过程、折叠一张卡片、图片从占位变成真实尺寸，浏览器
 *      会把 `scrollTop` 夹到新的底部——朝上的位移，但读者一步没动。
 *   2. **输入框聚焦**：移动端浏览器为了让光标可见会挪动整个滚动容器。
 *   3. **浏览器自己的 scroll anchoring**：上方行被移除时它替我们补偿位置。
 *
 * 判据因此不是「位置变小了」，而是「位置相对上一次**确认过的位置**变了」：
 * `movedByReader = |top - min(observed, floor)| > 0.5`。
 *
 * 那个 `min(observed, floor)` 是整件事的关键：内容缩短导致 `floor` 变小、浏览器把
 * `top` 夹到新的 `floor` 时，`min(observed, floor) === floor === top`，差值为 0，
 * 于是归因成「不是读者移动」，跟随意图原样保留。这一条与 DSH 的
 * `dsh-client-ui-chat/src/client/chat/use-scroll-follow.ts` 同一口径。
 *
 * **`observed` 只在「确认落点」时更新**（跟随、跳转、采样结算），不在每个 scroll
 * 事件里更新——后者等于每帧把基准抹掉，永远算不出位移。
 */
export class ScrollFollow {
  /** 内容增长时要不要继续贴底。 */
  following: boolean;
  /** 上一次确认过的 scrollTop。 */
  private observed = 0;

  constructor(
    following = true,
    private readonly threshold = 24,
  ) {
    this.following = following;
  }

  /** 距底不超过容差（px）就算「在底部」。 */
  nearBottom(metrics: ScrollMetrics): boolean {
    return Math.abs(metrics.floor - metrics.top) <= this.threshold;
  }

  /**
   * 读一次几何并归因。
   *
   * `movedByReader=false` 表示这次位移是内容/视口变化（或浏览器 clamp）造成的，
   * 不该拿它改跟随意图。
   */
  read(el: HTMLElement): { metrics: ScrollMetrics; movedByReader: boolean } {
    const metrics = scrollMetrics(el);
    const base = Math.min(this.observed, metrics.floor);
    return { metrics, movedByReader: Math.abs(metrics.top - base) > 0.5 };
  }

  /**
   * 结算一次滚动事件：只有读者真的移动了才改意图，并把这次位置登记成新基准。
   *
   * 不逐帧采样（惯性滚动里会来回翻）也不延后采样（那段时间内容会继续推着视口走）：
   * 一次 scroll 事件对应一次位置变化，按它结算最诚实。
   */
  sample(metrics: ScrollMetrics, movedByReader: boolean): boolean {
    if (movedByReader) {
      this.observed = metrics.top;
      this.following = this.nearBottom(metrics);
    }
    return this.following;
  }

  /** 把视口钉到内容底部；跟随意图恢复为 true。 */
  pin(el: HTMLElement): ScrollMetrics {
    el.scrollTop = el.scrollHeight;
    // 浏览器会把 scrollTop 夹到合法范围：登记夹过之后的真实值。
    const landed = scrollMetrics(el);
    this.observed = landed.top;
    this.following = true;
    return landed;
  }

  /** 即时定位到某个位置，并按落点决定还要不要跟随。 */
  jump(el: HTMLElement, top: number): ScrollMetrics {
    const before = scrollMetrics(el);
    el.scrollTop = Math.max(0, Math.min(before.floor, top));
    const landed = scrollMetrics(el);
    this.observed = landed.top;
    this.following = this.nearBottom(landed);
    return landed;
  }

  /** 放弃跟随（读者手势、显式跳转到中间某条）。 */
  release(): void {
    this.following = false;
  }

  /** 重新跟随（读者自己发消息、点「回到底部」）。 */
  resume(): void {
    this.following = true;
  }

  /** 内容整体替换（换对话）后对齐基准，不改意图。 */
  reset(top = 0): void {
    this.observed = top;
  }
}

/**
 * 内容变高时继续贴底跟随。
 *
 * 为什么需要它：`MessageList` 只在**数据结构**变化时跟随（新消息 / 流式追加会改
 * `items`），而展开一个折叠块（思考过程、工具卡片）只是内容变高、条数没变——
 * 新露出来的正文就留在视口外，表现是「点开没反应，得自己往下滚」。
 *
 * **要不要跟完全由 `shouldFollow` 决定**（`MessageList` 传的是 `ScrollFollow.following`，
 * `ProcessGroup` 传的是「正文没被往上滚过」）。这里不自己按几何算「贴不贴底」：
 * 内容变高时 scrollTop 还没动、scrollHeight 已经变大，任何「距底多远」的判定都会
 * 误判成「用户离开了底部」。
 *
 * `pin` 交给调用方：`MessageList` 要在写 `scrollTop` 的同时把落点登记成归因基准
 * （`ScrollFollow.pin`），否则下一次 scroll 事件会拿旧基准去比。不传就退回裸写。
 *
 * `enabled=false` 时整个跟随停用（例如过程组正文在手机上不限高、不是独立滚动区）。
 */
export function useFollowGrowth(
  scroll: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  shouldFollow: () => boolean,
  enabled = true,
  pin?: (el: HTMLElement) => void,
): void {
  const gate = useRef(shouldFollow);
  const write = useRef(pin);
  // **useLayoutEffect**：ResizeObserver 的回调可能在这一帧的绘制前跑，
  // 用 useEffect 更新会让它读到上一帧的意图（多跟/少跟一帧）。
  useLayoutEffect(() => {
    gate.current = shouldFollow;
    write.current = pin;
  });

  useEffect(() => {
    const el = scroll.current;
    const box = content.current;
    // 没有 ResizeObserver（老 WebView / 测试环境）时什么都不做：
    // 跟随退化成原来的「只看条数变化」，不会把滚动位置弄错。
    if (!enabled || !el || !box || typeof ResizeObserver === "undefined") return;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        if (!gate.current()) return;
        // 已经在底部就不必再写一次 scrollTop，免得打断正在进行的滚动。
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
        if (write.current) write.current(el);
        else el.scrollTop = el.scrollHeight;
      });
    });
    ro.observe(box);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scroll, content, enabled]);
}
