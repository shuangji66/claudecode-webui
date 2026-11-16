import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";

const OPTIONS = [
  { value: "default", label: "默认" },
  { value: "plan", label: "计划模式" },
];

describe("Select", () => {
  it("展开是自绘列表，不是原生 select", () => {
    render(<Select value="default" options={OPTIONS} onChange={() => {}} ariaLabel="权限模式" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(document.querySelector("select")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    expect(screen.getByRole("listbox", { name: "权限模式" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "计划模式" })).toBeInTheDocument();
  });

  it("点选项回调新值，选当前项不回调", () => {
    const onChange = vi.fn();
    render(<Select value="default" options={OPTIONS} onChange={onChange} ariaLabel="权限模式" />);

    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("option", { name: "计划模式" }));
    expect(onChange).toHaveBeenCalledWith("plan");

    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("option", { name: "默认" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("键盘可展开、移动并确认", () => {
    const onChange = vi.fn();
    render(<Select value="default" options={OPTIONS} onChange={onChange} ariaLabel="权限模式" />);

    const trigger = screen.getByRole("button", { name: "权限模式" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "权限模式" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("plan");

    // Esc 收起
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "权限模式" }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("禁用时不展开", () => {
    render(<Select value="default" options={OPTIONS} onChange={() => {}} ariaLabel="权限模式" disabled />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

// 权限模式里的「不询问 / 跳过权限」：菜单项与选中后的触发器都要标红。
describe("Select 危险选项", () => {
  const DANGEROUS = [
    { value: "default", label: "默认" },
    { value: "dontAsk", label: "不询问", danger: true },
    { value: "bypassPermissions", label: "跳过权限", danger: true },
  ];

  it("菜单里的危险项标红，安全项不标", () => {
    render(<Select value="default" options={DANGEROUS} onChange={() => {}} ariaLabel="权限模式" />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));

    expect(screen.getByRole("option", { name: "不询问" })).toHaveClass("text-danger");
    expect(screen.getByRole("option", { name: "跳过权限" })).toHaveClass("text-danger");
    expect(screen.getByRole("option", { name: "默认" })).not.toHaveClass("text-danger");
  });

  it("选中危险项后触发器也标红", () => {
    const { rerender } = render(
      <Select value="default" options={DANGEROUS} onChange={() => {}} ariaLabel="权限模式" />,
    );
    expect(screen.getByRole("button", { name: "权限模式" })).not.toHaveClass("text-danger");

    rerender(<Select value="bypassPermissions" options={DANGEROUS} onChange={() => {}} ariaLabel="权限模式" />);
    expect(screen.getByRole("button", { name: "权限模式" })).toHaveClass("text-danger");
  });
});
