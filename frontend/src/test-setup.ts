import "@testing-library/jest-dom/vitest";

/**
 * jsdom **声称**支持 `scrollend`（`'onscrollend' in window` 为 true），却从不派发它。
 *
 * 不关掉的话，`MessageList` 会以为可以用原生事件收尾、于是不再设置 150ms 定时器，
 * 而 `scrollend` 又永远不会来——「滚动停手后刷新锚点」这条路径在测试里就彻底断了
 * （表现为「收起一段内容后读者位置没被钉住」的用例失败）。
 *
 * 真实浏览器里这个属性是可信的；测试里必须走「不支持」那条退化路径。
 * 需要测原生 `scrollend` 的用例自己 `delete` 这个开关、再手动派发事件。
 */
(globalThis as { __ccwebNoScrollEnd?: boolean }).__ccwebNoScrollEnd = true;
