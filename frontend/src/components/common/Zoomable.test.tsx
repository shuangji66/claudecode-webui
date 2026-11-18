import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  ZoomBar,
  ZoomableImage,
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
