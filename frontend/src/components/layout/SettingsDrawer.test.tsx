import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { SettingsDrawer } from "./SettingsDrawer";

// 模型页（含凭证明文处理）已从设置页签挪到左侧栏功能区（整页视图，见 FeaturePage）：
// 它的用例在 settings/ModelsSettings.test.tsx，这里只钉住抽屉自己的那几页。
describe("设置页签", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 模型 / 技能 / 插件 / MCP 的入口都已挪到左侧栏功能区，设置抽屉里不再有这四页。
  it("不再包含模型 / 技能 / 插件 / MCP 页签", async () => {
    await act(async () => {
      render(<SettingsDrawer open onClose={() => {}} />);
    });
    const nav = screen.getByRole("navigation");
    for (const name of ["模型", "技能", "插件", "MCP"]) {
      expect(within(nav).queryByRole("button", { name })).toBeNull();
    }
    expect(within(nav).getByRole("button", { name: "通用" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "关于" })).toBeInTheDocument();
  });

  // CLI 页紧排在「通用」后面：它放的是最常调的两项子代理限制与空闲回收。
  it("CLI 页排在第二个", async () => {
    await act(async () => {
      render(<SettingsDrawer open onClose={() => {}} />);
    });
    const nav = screen.getByRole("navigation");
    const names = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names[0]).toBe("通用");
    expect(names[1]).toBe("CLI");
  });
});
