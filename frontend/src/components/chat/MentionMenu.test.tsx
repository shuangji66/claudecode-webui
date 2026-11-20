import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MentionMenu } from "./MentionMenu";
import type { MentionRow } from "./useMention";

const rows: MentionRow[] = [
  { path: "", name: "fnos", kind: "fnos" },
  { path: "src", name: "src", kind: "dir" },
  { path: "README.md", name: "README.md", kind: "file" },
];

function menu(highlight: number) {
  return (
    <MentionMenu
      rows={rows}
      crumbs={[]}
      highlight={highlight}
      loading={false}
      error={null}
      onHover={vi.fn()}
      onPick={vi.fn()}
      onDrill={vi.fn()}
      onCrumb={vi.fn()}
    />
  );
}

/** jsdom 没有 scrollIntoView：装一个桩，记下每一次调用。 */
function stubScrollIntoView() {
  const spy = vi.fn();
  Element.prototype.scrollIntoView = spy;
  return spy;
}

afterEach(() => {
  // @ts-expect-error 删掉桩，别漏给别的用例
  delete Element.prototype.scrollIntoView;
});

describe("MentionMenu 滚动跟随", () => {
  it("高亮行被滚进视野，其余行不动", () => {
    const spy = stubScrollIntoView();
    render(menu(2));

    expect(spy).toHaveBeenCalledTimes(1);
    // 被滚的是高亮那一条（README.md 所在的 li）。
    const scrolled = spy.mock.instances[0] as HTMLElement;
    expect(scrolled).toHaveTextContent("README.md");
  });

  it("高亮换行时跟着滚（↑↓ 把高亮带出列表也看得见）", () => {
    const spy = stubScrollIntoView();
    const { rerender } = render(menu(1));

    rerender(menu(2));

    expect(spy).toHaveBeenCalledTimes(2);
    const last = spy.mock.instances[1] as HTMLElement;
    expect(last).toHaveTextContent("README.md");
  });

  it("没有高亮时一条都不滚", () => {
    const spy = stubScrollIntoView();
    render(menu(-1));

    expect(spy).not.toHaveBeenCalled();
  });
});
