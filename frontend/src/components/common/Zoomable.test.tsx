import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  ZoomBar,
  ZoomableImage,
  clampPan,
  clampZoom,
  fitSize,
  stepZoom,
} from "./Zoomable";

describe("stepZoom", () => {
  it("按步进增减并抹掉浮点尾巴", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.9, 1)).toBe(1.15);
  });

  it("夹在上下限之间", () => {
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  it("从下限一路加能停在上限", () => {
    let z = MIN_ZOOM;
    for (let i = 0; i < 40; i += 1) z = stepZoom(z, 1);
    expect(z).toBe(MAX_ZOOM);
    expect(ZOOM_STEP).toBe(0.25);
  });
});

describe("clampZoom", () => {
  it("原样保留区间内的连续值（滚轮给的不是步进的整数倍）", () => {
    expect(clampZoom(1.37)).toBe(1.37);
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
  });
});

describe("clampPan", () => {
  it("图片比容器大时，最多挪到图片边缘贴住容器边缘", () => {
    // 800×600 的图在 400×400 的窗口里：横向最多 ±200，纵向 ±100。
    expect(clampPan({ x: 500, y: -500 }, { w: 800, h: 600 }, { w: 400, h: 400 })).toEqual({ x: 200, y: -100 });
    expect(clampPan({ x: 60, y: 40 }, { w: 800, h: 600 }, { w: 400, h: 400 })).toEqual({ x: 60, y: 40 });
  });

  // 缩回 1 倍时图片比容器小，上限是 0：不强制居中会让「拖歪了」这个状态留到下一眼。
  it("图片比容器小时强制居中", () => {
    expect(clampPan({ x: 80, y: -40 }, { w: 200, h: 100 }, { w: 400, h: 400 })).toEqual({ x: 0, y: 0 });
  });

  it("只有一个方向溢出时，另一个方向仍然居中", () => {
    expect(clampPan({ x: 30, y: 90 }, { w: 800, h: 200 }, { w: 400, h: 400 })).toEqual({ x: 30, y: 0 });
  });
});

describe("fitSize", () => {
  const BOX = { w: 400, h: 400 };

  it("小图按原始像素显示，不放大", () => {
    expect(fitSize({ w: 100, h: 80 }, BOX, 1)).toEqual({ w: 100, h: 80 });
  });

  it("宽图按宽度缩小", () => {
    const r = fitSize({ w: 1200, h: 800 }, BOX, 1);
    expect(r.w).toBeCloseTo(400);
    expect(r.h).toBeCloseTo(266.67);
  });

  it("竖长图按高度缩小", () => {
    const r = fitSize({ w: 300, h: 1200 }, BOX, 1);
    expect(r.w).toBeCloseTo(100);
    expect(r.h).toBeCloseTo(400);
  });

  it("zoom 在「原始或适应」的基准上放大", () => {
    // 小图：100 → 200
    expect(fitSize({ w: 100, h: 80 }, BOX, 2)).toEqual({ w: 200, h: 160 });
    // 大图：基准 400 → 800（超出窗口，靠外层滚动）
    expect(fitSize({ w: 1200, h: 800 }, BOX, 2).w).toBeCloseTo(800);
  });

  it("尺寸未知时返回 0，调用方退回 CSS 自适应", () => {
    expect(fitSize({ w: 0, h: 0 }, BOX, 1)).toEqual({ w: 0, h: 0 });
    expect(fitSize({ w: 100, h: 80 }, { w: 0, h: 0 }, 1)).toEqual({ w: 0, h: 0 });
  });
});

describe("ZoomBar", () => {
  it("显示百分比并回调新值", () => {
    const seen: number[] = [];
    render(<ZoomBar zoom={1} onChange={(z) => seen.push(z)} />);
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /放大|Zoom in/ }));
    fireEvent.click(screen.getByRole("button", { name: /缩小|Zoom out/ }));
    expect(seen).toEqual([1.25, 0.75]);
  });

  it("到边界时按钮禁用、重置在 100% 时禁用", () => {
    const { rerender } = render(<ZoomBar zoom={MIN_ZOOM} onChange={() => {}} />);
    expect((screen.getByRole("button", { name: /缩小|Zoom out/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ZoomBar zoom={MAX_ZOOM} onChange={() => {}} />);
    expect((screen.getByRole("button", { name: /放大|Zoom in/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ZoomBar zoom={1} onChange={() => {}} />);
    expect((screen.getByRole("button", { name: /重置|Reset/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ZoomableImage", () => {
  let roCallback: ResizeObserverCallback | null = null;

  afterEach(() => {
    roCallback = null;
    vi.unstubAllGlobals();
  });

  /** 挂载 → 给容器和图片灌尺寸 → 返回 img。 */
  function mount(w: number, h: number, naturalW: number, naturalH: number, zoom: number) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          roCallback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const { container } = render(<ZoomableImage src="/a.png" alt="图" zoom={zoom} />);
    const box = container.firstElementChild as HTMLElement;
    Object.defineProperty(box, "clientWidth", { value: w, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: h, configurable: true });
    act(() => roCallback?.([], {} as ResizeObserver));
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: naturalW, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: naturalH, configurable: true });
    fireEvent.load(img);
    return img;
  }

  it("小图不放大：320×240 在 400×400 里仍是 320×240", () => {
    const img = mount(400, 400, 320, 240, 1);
    expect(img.style.width).toBe("320px");
    expect(img.style.height).toBe("240px");
  });

  it("大图按长边缩小：1200×800 在 400×400 里变成 400×267", () => {
    const img = mount(400, 400, 1200, 800, 1);
    expect(parseFloat(img.style.width)).toBeCloseTo(400, 0);
    expect(parseFloat(img.style.height)).toBeCloseTo(266.67, 1);
  });

  it("zoom=2 在基准上放大（小图翻倍、大图超出窗口）", () => {
    expect(mount(400, 400, 100, 80, 2).style.width).toBe("200px");
    expect(parseFloat(mount(400, 400, 1200, 800, 2).style.width)).toBeCloseTo(800, 0);
  });

  it("尺寸未知时不写死宽高（退回 CSS 自适应）", () => {
    const { container } = render(<ZoomableImage src="/a.png" alt="图" zoom={1} />);
    expect((container.querySelector("img") as HTMLImageElement).style.width).toBe("");
  });

  it("点击图片回调", () => {
    const onClick = vi.fn();
    const { container } = render(<ZoomableImage src="/a.png" alt="图" zoom={1} onImgClick={onClick} />);
    fireEvent.click(container.querySelector("img")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ZoomableImage 滚轮缩放与拖动（pannable）", () => {
  let roCallback: ResizeObserverCallback | null = null;

  afterEach(() => {
    roCallback = null;
    vi.unstubAllGlobals();
  });

  /** 挂载 pannable 版本 → 灌尺寸 → 返回 { box, img }。 */
  function mountPannable(opts: {
    box: { w: number; h: number };
    natural: { w: number; h: number };
    zoom: number;
    onZoomChange: (z: number) => void;
  }) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          roCallback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const { container, rerender } = render(
      <ZoomableImage
        src="/a.png"
        alt="图"
        zoom={opts.zoom}
        pannable
        onZoomChange={opts.onZoomChange}
      />,
    );
    const box = container.firstElementChild as HTMLElement;
    Object.defineProperty(box, "clientWidth", { value: opts.box.w, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: opts.box.h, configurable: true });
    act(() => roCallback?.([], {} as ResizeObserver));
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: opts.natural.w, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: opts.natural.h, configurable: true });
    fireEvent.load(img);
    return { box, img, rerender };
  }

  it("滚轮向上放大、向下缩小，并把新倍数回写给调用方", () => {
    const seen: number[] = [];
    const { box } = mountPannable({ box: { w: 400, h: 400 }, natural: { w: 800, h: 800 }, zoom: 1, onZoomChange: (z) => seen.push(z) });
    fireEvent.wheel(box, { deltaY: -100 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(1);
    fireEvent.wheel(box, { deltaY: 100 });
    expect(seen[1]).toBeLessThan(seen[0]!);
  });

  // Ctrl + 滚轮是浏览器/系统的捏合缩放：灯箱抢过来就放不大了。
  it("Ctrl + 滚轮不接管", () => {
    const seen: number[] = [];
    const { box } = mountPannable({ box: { w: 400, h: 400 }, natural: { w: 800, h: 800 }, zoom: 1, onZoomChange: (z) => seen.push(z) });
    fireEvent.wheel(box, { deltaY: -100, ctrlKey: true });
    expect(seen).toHaveLength(0);
  });

  it("拖动时按位移平移，拖出边界会被夹住", () => {
    // zoom=2：800×800 的图在 400×400 的窗口里显示成 800×800，横向/纵向上限都是 ±200。
    // zoom=1 时它正好贴合窗口，没有可挪的余量（那也是一个要保证的分支，见下一条）。
    const { box, img } = mountPannable({ box: { w: 400, h: 400 }, natural: { w: 800, h: 800 }, zoom: 2, onZoomChange: () => {} });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 260, clientY: 240 });
    expect(img.style.transform).toContain("translate(calc(-50% + 60px), calc(-50% + 40px))");

    // 继续拖出窗口：上限是 200。
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 900, clientY: 900 });
    expect(img.style.transform).toContain("translate(calc(-50% + 200px), calc(-50% + 200px))");

    fireEvent.pointerUp(box, { pointerId: 1 });
  });

  it("图正好贴合窗口（zoom=1、比例相同）时拖不动", () => {
    const { box, img } = mountPannable({ box: { w: 400, h: 400 }, natural: { w: 800, h: 800 }, zoom: 1, onZoomChange: () => {} });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 400, clientY: 400 });
    expect(img.style.transform).toContain("translate(calc(-50% + 0px), calc(-50% + 0px))");
    fireEvent.pointerUp(box, { pointerId: 1 });
  });

  it("拖过之后缩回 1 倍，平移自己归零", () => {
    const { box, img, rerender } = mountPannable({ box: { w: 400, h: 400 }, natural: { w: 800, h: 800 }, zoom: 2, onZoomChange: () => {} });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 380, clientY: 380 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    expect(img.style.transform).toContain("180px");

    rerender(<ZoomableImage src="/a.png" alt="图" zoom={1} pannable onZoomChange={() => {}} />);
    expect(img.style.transform).toContain("translate(calc(-50% + 0px), calc(-50% + 0px))");
  });

  it("没开 pannable 时不写 transform（仍靠外层滚动）", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          roCallback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const { container } = render(<ZoomableImage src="/a.png" alt="图" zoom={2} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.style.transform).toBe("");
  });
});
