import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageLightbox } from "./ImageLightbox";

describe("ImageLightbox", () => {
  it("渲染图片与标题", () => {
    const { container } = render(<ImageLightbox src="/api/fs/raw?x=1" alt="四色图" onClose={() => {}} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/fs/raw?x=1");
    expect(screen.getByText("四色图")).toBeTruthy();
  });

  it("没有 src 时不渲染", () => {
    const { container } = render(<ImageLightbox src={null} alt="x" onClose={() => {}} />);
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("给了 onOpenSidebar 才出现「在右侧栏打开」，点击后回调", () => {
    const onOpen = vi.fn();
    render(<ImageLightbox src="/a.png" alt="图" rel="probe/quad.png" onClose={() => {}} onOpenSidebar={onOpen} />);
    const btn = screen.getByRole("button", { name: /在右侧栏打开/ });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 路径要露出来，用户能确认打开的是哪个文件
    expect(screen.getByText("probe/quad.png")).toBeTruthy();
  });

  it("内联图片不给这个按钮", () => {
    render(<ImageLightbox src="data:image/png;base64,AAA" alt="图" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /在右侧栏打开/ })).toBeNull();
  });

  it("关闭按钮触发 onClose", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/a.png" alt="图" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /关闭|Close/ }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ImageLightbox 缩放", () => {
  it("默认 100%，点放大后递增", () => {
    render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /放大|Zoom in/ }));
    expect(screen.getByText("125%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /放大|Zoom in/ }));
    expect(screen.getByText("150%")).toBeTruthy();
  });

  it("点缩小后递减，且到下限后按钮禁用", () => {
    render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    const out = screen.getByRole("button", { name: /缩小|Zoom out/ });
    fireEvent.click(out);
    expect(screen.getByText("75%")).toBeTruthy();
    for (let i = 0; i < 2; i += 1) fireEvent.click(out);
    expect(screen.getByText("50%")).toBeTruthy();
    expect((out as HTMLButtonElement).disabled).toBe(true);
  });

  it("重置回到 100%", () => {
    render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    const zoomIn = screen.getByRole("button", { name: /放大|Zoom in/ });
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(screen.getByText("150%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /重置|Reset/ }));
    expect(screen.getByText("100%")).toBeTruthy();
  });
});

describe("ImageLightbox 预览窗口", () => {
  it("预览区是固定 1:1 的正方形（边长取容器短边）", () => {
    const { container } = render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    const box = container.querySelector("[style*='aspect-ratio']") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.style.aspectRatio).toBe("1 / 1");
    expect(box.style.width).toBe("min(100cqw, 100cqh)");
  });

  it("桌面端尺寸与设置弹窗一致（82vh / 900px）", () => {
    const { container } = render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    const panel = container.querySelector("[role=dialog]") as HTMLElement;
    expect(panel.className).toContain("md:h-[82vh]");
    expect(panel.className).toContain("md:max-w-[900px]");
  });
});
