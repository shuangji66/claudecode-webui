import { useEffect, useRef, type RefObject } from "react";

/**
 * 内容变高时继续贴底跟随。
 *
 * 为什么需要它：`MessageList` 原来只在**消息条数**变化时跟随（新消息 / 流式追加会改
 * `items`），而展开一个折叠块（思考过程、工具卡片）只是内容变高、条数没变——
 * 新露出来的正文就留在视口外，表现是「点开没反应，得自己往下滚」。
 *
 * **要不要跟完全由 `shouldFollow` 决定**（`MessageList` 传的是自己那份 `stick`，
 * `ProcessGroup` 传的是「正文没被往上滚过」）。这里不自己按几何算「贴不贴底」：
 * 流式输出时内容常在下一个 scroll 事件被处理前又高了一截，此刻 scrollTop 还没动、
 * scrollHeight 已经变大，任何「距底多远」的判定都会误判成「用户离开了底部」，
 * 把跟随悄悄关掉——表现是「滚着滚着突然不跟了」。
 *
 * `shouldFollow` 每次渲染同步进 ref，所以不必放进依赖数组（放进去会让观察器每渲染
 * 重建一遍）。`enabled=false` 时整个跟随停用（例如过程组正文在手机上不限高、
 * 不是独立滚动区）。
 *
 * 需要「往上滚就停、滚回底部恢复」的滚动区，自己维护那个状态并交给 `shouldFollow`。
 */
export function useFollowGrowth(
  scroll: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  shouldFollow: () => boolean,
  enabled = true,
): void {
  const gate = useRef(shouldFollow);
  useEffect(() => {
    gate.current = shouldFollow;
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
        el.scrollTop = el.scrollHeight;
      });
    });
    ro.observe(box);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scroll, content, enabled]);
}
