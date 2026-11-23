import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WakeRow } from "./WakeRow";
import type { WakeItem } from "../../lib/model";

const item = (over: Partial<WakeItem> = {}): WakeItem => ({
  id: "w1",
  seq: 0,
  ts: Date.UTC(2026, 10, 24, 4, 14),
  kind: "wake",
  origin: "task",
  taskId: "agent-1",
  toolUseId: "toolu_01",
  status: "completed",
  summary: 'Agent "找一篇近期新闻" finished',
  text: '<task-notification>\n<task-id>agent-1</task-id>\n<result>这是一份很长的报告</result>\n</task-notification>',
  ...over,
});

describe("WakeRow", () => {
  it("写一句人话，不是用户气泡、也不是原始 XML", () => {
    const { container } = render(<WakeRow item={item()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("子代理「找一篇近期新闻」已完成");
    // 通知原文默认折叠着：摆进正文流就成了一坨 XML。
    expect(text).not.toContain("<task-id>");
  });

  it("点开才看通知原文（对齐 DSH：raw body 在 details 里）", () => {
    render(<WakeRow item={item()} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(screen.getByText(/这是一份很长的报告/)).toBeInTheDocument();
  });

  it("失败 / 被停止各说各的，不都说「已完成」", () => {
    const failed = render(<WakeRow item={item({ status: "failed" })} />);
    expect(failed.container.textContent).toContain("失败了");
    failed.unmount();
    const stopped = render(<WakeRow item={item({ status: "stopped" })} />);
    expect(stopped.container.textContent).toContain("已停止");
  });

  it("后台命令（没有引号包着的名字）照样成一条，不因此空白", () => {
    const { container } = render(
      <WakeRow item={item({ id: "w2", summary: 'Background command "Run mock server" was stopped' })} />,
    );
    expect((container.textContent ?? "").trim()).not.toBe("");
    expect(container.textContent).toContain("Run mock server");
  });
});
