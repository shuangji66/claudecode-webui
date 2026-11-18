// 原生拖拽的「拖影」由浏览器自己截图：尺寸与缩放都不受控，
// 手机上会明显缩小，看起来像把被拖的那一行压扁了。
//
// 这里自己造一块与行同尺寸、不透明的拖影塞给 `dataTransfer.setDragImage`
// （对齐 DSH 的 `useRowDragPreview`）：外壳与行一样宽，里面是行的克隆，
// 因此拖动中的卡片与列表里的那一行一模一样。

/** 当前留在 DOM 里的拖影外壳（一次只有一个）。 */
let active: HTMLElement | null = null;

export function clearDragPreview(): void {
  active?.remove();
  active = null;
}

/**
 * 为本次拖拽挂一块全尺寸拖影。
 *
 * 外壳贴在视口左侧之外：`setDragImage` 只截取它这一块，位置本身不影响画面，
 * 但不能让它一闪而过地出现在屏幕上。返回值为是否挂上（浏览器不给 API 时静默跳过）。
 */
export function startDragPreview(
  dataTransfer: { setDragImage?: (node: Element, x: number, y: number) => void } | null | undefined,
  el: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  clearDragPreview();
  if (typeof dataTransfer?.setDragImage !== "function") return false;

  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  // 克隆里的按钮/链接不再是可交互元素：拖影只是一张图，不要留下焦点顺序。
  const clone = el.cloneNode(true) as HTMLElement;
  clone.tabIndex = -1;
  for (const node of Array.from(
    clone.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex], [contenteditable]"),
  )) {
    node.tabIndex = -1;
  }

  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  const wrap = document.createElement("div");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.position = "fixed";
  // 往左让出一个自身宽度：截图时它就在视口外，用户看不到这层「替身」。
  wrap.style.left = `${-(width + 40)}px`;
  wrap.style.top = "0px";
  wrap.style.width = `${width}px`;
  wrap.style.height = `${height}px`;
  wrap.style.pointerEvents = "none";
  wrap.style.overflow = "hidden";
  // 行本身是透明底：拖影必须自带不透明背景，否则路上的文字会透出来。
  wrap.style.background = "var(--color-panel)";
  wrap.style.borderRadius = "10px";
  wrap.style.boxShadow = "0 12px 28px rgb(0 0 0 / 0.18)";
  wrap.style.font = computed.font;
  wrap.style.zIndex = "-1";
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  active = wrap;

  try {
    dataTransfer.setDragImage(wrap, clientX - rect.left, clientY - rect.top);
  } catch {
    // 某些 WebView 的 DataTransfer 是空壳：拖影退回浏览器默认样式，不影响排序本身。
    clearDragPreview();
    return false;
  }
  return true;
}
