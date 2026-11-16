import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "./Dialog";
import { Select } from "./Select";

// 回归：Select / Menu 的弹层是挂在 body 上的 Portal，React 事件却沿组件树冒泡到
// Dialog 的遮罩层；遮罩层用 DOM 包含关系判断「点在外面」，于是点一下下拉项就把
// 整个弹窗关掉（设置页里改协议、部署页里选版本都会踩到）。
describe("Dialog 与 Portal 弹层", () => {
  it("点击下拉选项不会关闭弹窗", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="测试弹窗" title="测试弹窗">
        <Select
          value="a"
          ariaLabel="选择"
          options={[
            { value: "a", label: "选项 A" },
            { value: "b", label: "选项 B" },
          ]}
          onChange={() => {}}
        />
      </Dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "选项 B" }));
    fireEvent.click(screen.getByRole("option", { name: "选项 B" }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("点击遮罩仍然关闭弹窗", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="测试弹窗" title="测试弹窗">
        <p>内容</p>
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
