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

  // 用户报过的 bug（截图）：一条后台命令跑完，界面上写的是「子代理「Background
  // command "cd /tmp &&…」已…」」——它不是子代理，用户会去找一个并不存在的子代理。
  // 角色词必须按 `<summary>` 的模板给，不能一律当前缀写死。
  it("后台命令不叫子代理，子代理才叫子代理", () => {
    const cmd = render(<WakeRow item={item({ summary: 'Background command "npm test" completed (exit code 0)' })} />);
    expect(cmd.container.textContent).toContain("后台命令「npm test」已完成");
    expect(cmd.container.textContent).not.toContain("子代理");
    cmd.unmount();

    const agent = render(<WakeRow item={item({ summary: 'Agent "找一篇新闻" finished' })} />);
    expect(agent.container.textContent).toContain("子代理「找一篇新闻」已完成");
    agent.unmount();

    const bgAgent = render(<WakeRow item={item({ status: "stopped", summary: 'Background agent "审查代码" didn\'t finish' })} />);
    expect(bgAgent.container.textContent).toContain("后台子代理「审查代码」已停止");
  });

  // `Background shell command didn't finish before the previous session ended` 这种
  // 没有引号的整句：以前会被截成「子代理Background shell command didn't…已停止」——
  // 一句英文半截挂在中文里，既不是名字也不像话。
  it("摘要里没有引号里的名字时只报角色 + 状态，整句放进悬停提示", () => {
    const summary = "Background shell command didn't finish before the previous session ended";
    const { container } = render(<WakeRow item={item({ status: "stopped", summary })} />);
    const text = container.textContent ?? "";
    expect(text).toContain("后台命令已停止");
    expect(text).not.toContain("didn't finish");
    expect(container.querySelector("button")?.getAttribute("title")).toBe(summary);
  });

  it("图标按类型给：子代理是火花，后台命令是终端", () => {
    const icon = (summary: string) =>
      render(<WakeRow item={item({ summary })} />).container.querySelector("button svg")?.outerHTML ?? "";
    // `Background agent` 里是小写的 "agent"，旧判定 `includes("Agent")` 认不出。
    expect(icon('Agent "x" finished')).toBe(icon('Background agent "y" finished'));
    expect(icon('Background command "npm test" completed (exit code 0)')).not.toBe(icon('Agent "x" finished'));
  });
});
