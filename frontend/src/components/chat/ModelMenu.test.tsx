import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModelMenu, groupModelOptions } from "./ModelMenu";
import type { ModelOption } from "../../lib/providerForm";

const OPTIONS: ModelOption[] = [
  {
    provider: "gw-a",
    providerName: "网关 A",
    model: "deepseek-v4",
    label: "DeepSeek V4 · 网关 A",
    spec: { name: "DeepSeek V4", reasoning_efforts: ["low", "high"], supports_image: true },
  },
  {
    provider: "gw-b",
    providerName: "网关 B",
    model: "qwen-max",
    label: "Qwen Max · 网关 B",
    spec: { reasoning_efforts: [] },
  },
];

function setup(overrides: Partial<React.ComponentProps<typeof ModelMenu>> = {}) {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  render(
    <ModelMenu
      options={OPTIONS}
      selectedKey="gw-a/deepseek-v4"
      selectedEffort="high"
      disabled={false}
      onSelectModel={onSelectModel}
      onSelectEffort={onSelectEffort}
      {...overrides}
    />,
  );
  return { onSelectModel, onSelectEffort };
}

describe("groupModelOptions", () => {
  it("按提供商分组并保持设置顺序", () => {
    const groups = groupModelOptions(OPTIONS);
    expect(groups.map((g) => g.id)).toEqual(["gw-a", "gw-b"]);
    expect(groups[0].models[0].model).toBe("deepseek-v4");
  });
});

describe("ModelMenu", () => {
  it("触发器只显示模型名与推理等级，不显示图片能力", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "模型与推理等级" });
    expect(trigger.textContent).toContain("DeepSeek V4");
    expect(trigger.textContent).toContain("High");
    expect(trigger.textContent).not.toContain("图片");
  });

  it("一级菜单是模型 / 推理等级两行", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    expect(screen.getByRole("menuitem", { name: /模型/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /推理等级/ })).toBeTruthy();
  });

  it("模型页按提供商分组，选中后回调并关闭", () => {
    const { onSelectModel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));

    expect(screen.getByText("网关 A")).toBeTruthy();
    expect(screen.getByText("网关 B")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /qwen-max/ }));
    expect(onSelectModel).toHaveBeenCalledWith("gw-b", "qwen-max");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("推理等级页列出档位并回调", () => {
    const { onSelectEffort } = setup();
    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /推理等级/ }));

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));
    expect(onSelectEffort).toHaveBeenCalledWith("low");
  });

  it("Esc 从二级页退回一级而不是直接关闭", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "模型与推理等级" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(screen.getByText("网关 A")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("网关 A")).toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
