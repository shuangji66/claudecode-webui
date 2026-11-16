import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { askConfirm, askPrompt, SystemDialogs } from "./SystemDialogs";

describe("SystemDialogs", () => {
  it("确认框点「确定」返回 true，点「取消」返回 false", async () => {
    render(<SystemDialogs />);

    let confirmed: boolean | null = null;
    await act(async () => {
      void askConfirm({ title: "删除对话", message: "不可撤销", danger: true }).then((v) => {
        confirmed = v;
      });
    });
    expect(await screen.findByRole("dialog", { name: "删除对话" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确定" }));
    });
    expect(confirmed).toBe(true);

    let cancelled: boolean | null = null;
    await act(async () => {
      void askConfirm({ title: "再确认一次" }).then((v) => {
        cancelled = v;
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(cancelled).toBe(false);
  });

  it("输入框带回用户输入，空值不能提交，取消返回 null", async () => {
    render(<SystemDialogs />);

    let answer: string | null = "unset";
    await act(async () => {
      void askPrompt({ title: "重命名工作区", initial: "旧名" }).then((v) => {
        answer = v;
      });
    });

    const input = await screen.findByRole("textbox", { name: "重命名工作区" });
    expect(input).toHaveValue("旧名");
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "确定" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "新名" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确定" }));
    });
    expect(answer).toBe("新名");

    let cancelled: string | null = "unset";
    await act(async () => {
      void askPrompt({ title: "新建文件夹" }).then((v) => {
        cancelled = v;
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(cancelled).toBeNull();
  });
});
