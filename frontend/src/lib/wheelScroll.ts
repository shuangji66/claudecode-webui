import { useEffect, type RefObject } from "react";

/** `WheelEvent.deltaMode === 1`（按行）时的估算行高：浏览器不给真实行高。 */
const LINE_HEIGHT = 16;

/**
 * 让横向溢出的容器也吃鼠标滚轮。
 *
 * 横向滚动区上没有纵轴，纵向滚轮默认**什么都不做**（Chrome 只把它交给父级去滚纵轴），
 * 用户只能去拖那条 8px 的细滚动条——右侧栏标签一多就非常难拖。这里把 `deltaY` 换成
 * `scrollLeft`，滚到头再让浏览器继续滚父级（不能无条件 `preventDefault`，否则滚到
 * 最后一个标签之后页面就卡住了）。
 *
 * 为什么用原生监听而不是 React 的 `onWheel`：React 17 起 root 上的 wheel 监听是
 * **passive** 的，`preventDefault()` 会被忽略并打一条控制台警告。
 *
 * 触控板的横向滑动（`deltaX`）本来就滚得动，不再插手。
 */
export function useWheelScrollX(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Ctrl + 滚轮是浏览器/系统的捏合缩放，抢过来就放不大了。
      if (e.ctrlKey) return;
      // 有横向增量时浏览器自己会滚（触控板），别把惯性与速度曲线弄丢。
      if (e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      const unit = e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? el.clientWidth : 1;
      const before = el.scrollLeft;
      el.scrollLeft = before + e.deltaY * unit;
      // 已经到左/右边界时 `scrollLeft` 不会变，此时放行，父级还能接着滚。
      if (el.scrollLeft !== before) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
