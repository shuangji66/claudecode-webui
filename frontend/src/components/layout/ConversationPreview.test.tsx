import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConversationPreview } from "./ConversationPreview";
import type { ConversationInfo } from "../../transport/types";

const conv: ConversationInfo = {
  id: "c1",
  cwd: "/w/demo",
  title: "标准模式是啥",
  created_at: "",
  last_active: "2026-01-02T00:00:00Z",
  messages: 4,
  archived: false,
  live: false,
};

const anchor = document.createElement("button");

describe("ConversationPreview", () => {
  it("显示标题、路径、时间、条数与状态", () => {
    render(<ConversationPreview anchor={anchor} conv={conv} title="标准模式是啥" path="/w/demo" status="active" />);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("标准模式是啥");
    expect(tip).toHaveTextContent("/w/demo");
    expect(tip).toHaveTextContent("4 条消息");
    // 状态写进卡片里，不再靠行上的原生 title 单独提示。
    expect(tip).toHaveTextContent("空闲");
    // 概览只回答「这是哪条对话、在哪、什么状态」：不再展示最近一问一答。
    expect(tip.querySelector(".line-clamp-2")).toBeNull();
    expect(tip.querySelector(".line-clamp-3")).toBeNull();
  });

  it("状态文案跟着会话状态走", () => {
    const { rerender } = render(
      <ConversationPreview anchor={anchor} conv={conv} title="t" path="/w/demo" status="ongoing" />,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("运行中");

    rerender(<ConversationPreview anchor={anchor} conv={conv} title="t" path="/w/demo" status="off" />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("未运行");
  });
});
