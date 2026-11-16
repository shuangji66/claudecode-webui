import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspacePicker } from "./WorkspacePicker";
import type { WorkspaceEntry } from "../../transport/types";

const ws = (path: string, name: string): WorkspaceEntry => ({
  path,
  name,
  last_used: "",
  exists: true,
});

const WORKSPACES = [ws("/vol1/1000/tmp", "tmp"), ws("/vol1/1000/workspace/app", "app")];

function setup(overrides: Partial<React.ComponentProps<typeof WorkspacePicker>> = {}) {
  const onPick = vi.fn();
  const onAdd = vi.fn();
  render(<WorkspacePicker workspaces={WORKSPACES} current="/vol1/1000/tmp" onPick={onPick} onAdd={onAdd} {...overrides} />);
  return { onPick, onAdd };
}

describe("WorkspacePicker", () => {
  it("触发器显示当前工作区的显示名", () => {
    setup();
    expect(screen.getByRole("button", { name: "工作区" })).toHaveTextContent("tmp");
  });

  it("展开后列出全部工作区，选中即回调该路径", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));

    const item = screen.getByRole("menuitem", { name: /app/ });
    fireEvent.click(item);
    expect(onPick).toHaveBeenCalledWith("/vol1/1000/workspace/app");
  });

  it("菜单里带「添加授权目录…」入口", () => {
    const { onAdd } = setup();
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));

    fireEvent.click(screen.getByRole("menuitem", { name: /添加授权目录/ }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("一个目录都没授权时，点一下直接走「添加授权目录」而不是弹空菜单", () => {
    const { onAdd } = setup({ workspaces: [], current: "" });

    fireEvent.click(screen.getByRole("button", { name: "工作区" }));

    expect(onAdd).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
