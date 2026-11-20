// 「有没有精确指针」= 桌面鼠标。触屏（手机 / 平板）没有。
//
// 唯一用途是决定**要不要自动聚焦输入框**：手机上打开一个带搜索框的弹窗就
// 立刻弹出软键盘，把大半个列表顶走（历史记录页的搜索框踩过，见那里的注释）。
// 桌面则相反，聚焦搜索框是最好的默认——目录动辄几十条，键盘直接筛比找滚动条快。
//
// 用 `(pointer: fine)` 而不是宽度断点：平板横屏够宽，但仍然是触屏，弹键盘一样烦人。
// jsdom（单测）没有 matchMedia 实现，读不到就按桌面处理——测试断言的是「桌面会聚焦」，
// 这样不必在每个测试里桩一个 matchMedia。
export function hasFinePointer(): boolean {
  if (typeof window === "undefined") return true;
  const mq = window.matchMedia?.("(pointer: fine)");
  return mq ? mq.matches : true;
}
