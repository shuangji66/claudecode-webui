import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { UserBubble } from "./UserBubble";

const IMAGES = [
  { name: "shot.png", mediaType: "image/png", data: "AA" },
  { name: "photo.jpg", mediaType: "image/jpeg", data: "BB" },
];

describe("UserBubble", () => {
  it("纯文本气泡不变", () => {
    render(<UserBubble text="你好" ts={1700000000000} />);
    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /预览图片/ })).toBeNull();
  });

  it("图片附件直接画在气泡里，正文与图片同时存在", () => {
    const { container } = render(<UserBubble text="看图" images={IMAGES} />);
    const thumbs = container.querySelectorAll("img");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0].getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(thumbs[1].getAttribute("src")).toBe("data:image/jpeg;base64,BB");
    expect(screen.getByText("看图")).toBeInTheDocument();
  });

  it("点缩略图打开大图，关闭后收起", () => {
    render(<UserBubble text="" images={IMAGES} />);

    fireEvent.click(screen.getByRole("button", { name: "预览图片 shot.png" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(within(dialog).getByText("shot.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("只发图片时气泡里没有空的文本节点", () => {
    const { container } = render(<UserBubble text="" images={IMAGES} />);
    // 只有两个缩略图，没有额外的空白正文块。
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelector(".whitespace-pre-wrap")).toBeNull();
  });
});
