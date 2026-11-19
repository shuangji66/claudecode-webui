import { useEffect, useRef, type RefObject } from "react";

/**
 * 内容变高时继续贴底跟随。
 *
 * 为什么需要它：`MessageList` 原来只在**消息条数**变化时跟随（新消息 / 流式追加会改
 * `items`），而展开一个折叠块（思考过程、工具卡片）只是内容变高、条数没变——
 * 新露出来的正文就留在视口外，表现是「点开没反应，得自己往下滚」。
 *
 * 「要不要跟」只看滚动位置：滚动区被往上滑过就停下，手动划回底部自然恢复，
 * 界面上不显示任何额外状态。位置在这里自己跟踪（初始按几何量一次 + 监听 scroll），
 * **不能在 ResizeObserver 回调里现算**：内容变高的那一刻 scrollHeight 已经变大、
 * scrollTop 还没动，现算必然得出「不贴底」，于是永远不跟。
 *
 * `shouldFollow` 是调用方的额外闸门（`MessageList` 用它复用自己那份贴底判断），
 * 每次渲染同步进 ref，所以不必放进依赖数组。`slack` 与调用方的「算贴底」阈值保持一致
 * （对话区用 100px，见 `MessageList.onScroll`）：这里更严的话，会出现「新消息会跟、
 * 展开不跟」。`enabled=false` 时整个跟随停用（例如过程组正文在手机上不限高、
 * 不是独立滚动区）。
 */
export function useFollowGrowth(
  scroll: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  shouldFollow: () => boolean = () => true,
  enabled = true,
  slack = 2,
): void {
  const gate = useRef(shouldFollow);
  useEffect(() => {
    gate.current = shouldFollow;
  });

  /** 滚动区此刻是不是贴着底：只由 scroll 事件与初始几何更新。 */
  const atBottom = useRef(true);

  useEffect(() => {
    const el = scroll.current;
    const box = content.current;
    // 没有 ResizeObserver（老 WebView / 测试环境）时什么都不做：
    // 跟随退化成原来的「只看条数变化」，不会把滚动位置弄错。
    if (!enabled || !el || !box || typeof ResizeObserver === "undefined") return;

    const away = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const sync = () => {
      atBottom.current = away() <= slack;
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        if (!gate.current() || !atBottom.current) return;
        // 已经在底部就不必再写一次 scrollTop，免得打断正在进行的滚动。
        if (away() <= slack) return;
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
      });
    });
    ro.observe(box);
    return () => {
      el.removeEventListener("scroll", sync);
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scroll, content, enabled, slack]);
}
