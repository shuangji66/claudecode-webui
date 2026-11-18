import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
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

// 回归：多层弹窗叠加时，下层**自己**重渲染不能抢走「栈尾」。
//
// 调用点几乎都传内联 onClose；effect 依赖里带着它，下层任何一次自身重渲染都会让它
// 先从栈里摘掉自己、再压回栈顶 —— 之后 Esc 关的是下层，上层再也关不掉，
// 而且 body.overflow 被还原成打开前的值，背景又能滚了。
describe("Dialog 叠加", () => {
  it("下层自身重渲染后 Esc 仍关最上面那个，且背景保持锁定", () => {
    const closeLower = vi.fn();
    const closeUpper = vi.fn();

    function Lower() {
      const [tick, setTick] = useState(0);
      return (
        <Dialog open onClose={() => closeLower()} label="下层" title="下层">
          <button type="button" onClick={() => setTick(tick + 1)}>
            bump {tick}
          </button>
        </Dialog>
      );
    }

    render(
      <>
        <Lower />
        <Dialog open onClose={() => closeUpper()} label="上层" title="上层">
          <p>upper</p>
        </Dialog>
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    // 只让下层重渲染（模拟 store 事件导致无关重绘）。
    fireEvent.click(screen.getByRole("button", { name: /bump/ }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(closeLower).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");
  });
});

describe("Dialog 的居中模式", () => {
  it("centered 时移动端也居中、四角圆角（不再从底部升起）", () => {
    const { container } = render(
      <Dialog open onClose={() => {}} label="图" centered>
        <img src="/a.png" alt="图" />
      </Dialog>,
    );
    const overlay = container.querySelector(".fixed") as HTMLElement;
    expect(overlay.className).toContain("items-center");
    expect(overlay.className).not.toContain("items-end");
    // 四角圆角：不能是只圆上面两角
    expect(overlay.querySelector("[role=dialog]")?.className).toContain("rounded-2xl");
    expect(overlay.querySelector("[role=dialog]")?.className).not.toContain("rounded-t-2xl");
  });

  it("默认（表单类）仍是底部 sheet", () => {
    const { container } = render(
      <Dialog open onClose={() => {}} label="表单">
        <p>内容</p>
      </Dialog>,
    );
    const overlay = container.querySelector(".fixed") as HTMLElement;
    expect(overlay.className).toContain("items-end");
  });
});
