import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageLightbox } from "./ImageLightbox";
import { UserBubble } from "./UserBubble";

describe("ImageLightbox", () => {
  it("渲染图片与标题", () => {
    const { baseElement } = render(<ImageLightbox src="/api/fs/raw?x=1" alt="四色图" onClose={() => {}} />);
    expect(baseElement.querySelector("img")?.getAttribute("src")).toBe("/api/fs/raw?x=1");
    expect(screen.getByText("四色图")).toBeTruthy();
  });

  it("没有 src 时不渲染", () => {
    const { baseElement } = render(<ImageLightbox src={null} alt="x" onClose={() => {}} />);
    expect(baseElement.querySelector("[role=dialog]")).toBeNull();
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

  // 滚轮缩放与按钮走同一个 zoom 状态：底部百分比要跟着动，不是两套数。
  it("在图片区滚轮也能缩放，百分比同步更新", () => {
    const { baseElement } = render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    const box = baseElement.querySelector("img")!.parentElement as HTMLElement;
    fireEvent.wheel(box, { deltaY: -100 });
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByText(/%$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /重置|Reset/ }));
    expect(screen.getByText("100%")).toBeTruthy();
  });
});

describe("ImageLightbox 预览窗口", () => {
  // 曾经是固定 1:1 的正方形（边长取容器短边）。宽图上下、竖图左右各留一大片黑，
  // 图片区只占弹窗中间一小块。现在图片区铺满面板，取景交给缩放 + 平移。
  it("图片区铺满面板，不再套固定比例的正方形", () => {
    const { baseElement } = render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    expect(baseElement.querySelector("[style*='aspect-ratio']")).toBeNull();
    expect(baseElement.querySelector("[style*='container-type']")).toBeNull();
    const img = baseElement.querySelector("img") as HTMLElement;
    expect(img.closest(".overflow-hidden")).toBeTruthy();
  });

  it("桌面端尺寸与设置弹窗一致（82vh / 900px）", () => {
    const { baseElement } = render(<ImageLightbox src="/a.png" alt="图" onClose={() => {}} />);
    const panel = baseElement.querySelector("[role=dialog]") as HTMLElement;
    expect(panel.className).toContain("md:h-[82vh]");
    expect(panel.className).toContain("md:max-w-[900px]");
  });

  // 回归：灯箱曾被关在单条消息里（消息行有 content-visibility: auto → contain: paint
  // 建立 fixed 包含块并裁剪溢出），表现为一个很小的窗口、遮罩缺一块、桌面上也关不掉。
  it("挂在 body 上，不嵌在触发它的消息行里", () => {
    const { container, baseElement } = render(
      <div style={{ contentVisibility: "auto" }}>
        <UserBubble text="带图的消息" images={[{ name: "a.png", mediaType: "image/png", data: "AAA" }]} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /预览图片/ }));
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(baseElement.querySelector("[role=dialog]")).toBeTruthy();
    // 关闭按钮就在面板里，能点到。
    fireEvent.click(screen.getByRole("button", { name: /关闭|Close/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
