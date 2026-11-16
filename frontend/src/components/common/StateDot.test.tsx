import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { StateDot } from "./StateDot";

describe("StateDot", () => {
  it("进行中画的是会转的进度环，不是圆点", () => {
    const { container } = render(<StateDot state="ongoing" />);
    const svg = container.querySelector("svg.state-dot-spinner");
    expect(svg).not.toBeNull();
    expect(svg!.querySelector(".state-dot-spin")).not.toBeNull();
    expect(container.querySelector(".state-dot")).toBeNull();
  });

  it("其余状态是圆点，颜色由 data-state 决定", () => {
    for (const state of ["approval", "done", "off"] as const) {
      const { container, unmount } = render(<StateDot state={state} />);
      const dot = container.querySelector(`.state-dot-${state}`);
      expect(dot).not.toBeNull();
      expect(dot!.getAttribute("data-state")).toBe(state);
      expect(container.querySelector("svg")).toBeNull();
      unmount();
    }
  });

  it("尺寸可覆盖：进度环默认 14px，圆点默认 10px", () => {
    const { container: ring } = render(<StateDot state="ongoing" />);
    expect(ring.querySelector("svg")!.getAttribute("width")).toBe("14");
    const { container: dot } = render(<StateDot state="off" />);
    expect((dot.querySelector(".state-dot") as HTMLElement).style.width).toBe("10px");
  });
});
