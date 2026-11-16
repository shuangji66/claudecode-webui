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
  it("显示标题、工作区、时间与最近一问一答", () => {
    render(
      <ConversationPreview
        anchor={anchor}
        conv={conv}
        title="标准模式是啥"
        workspace="demo"
        preview={{ user: "标准模式是啥，有没有重复", assistant: "「标准模式」是空值，确实重复了" }}
        loading={false}
      />,
    );
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("标准模式是啥");
    expect(tip).toHaveTextContent("demo");
    expect(tip).toHaveTextContent("4 条消息");
    expect(tip).toHaveTextContent("标准模式是啥，有没有重复");
    expect(tip).toHaveTextContent("确实重复了");
  });

  it("加载中显示占位，没有内容时给提示", () => {
    const { rerender } = render(
      <ConversationPreview anchor={anchor} conv={conv} title="t" workspace="demo" preview={null} loading />,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("正在加载…");

    rerender(
      <ConversationPreview anchor={anchor} conv={conv} title="t" workspace="demo" preview={{}} loading={false} />,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("还没有内容");
  });
});
