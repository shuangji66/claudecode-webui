import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import { useSidebarStore } from "../../store/useSidebarStore";

const CWD = "/vol1/1000/demo";

function seed() {
  useSidebarStore.setState({
    cwd: CWD,
    levels: {
      "": [
        { name: "src", path: "src", type: "dir" },
        { name: "README.md", path: "README.md", type: "file", size: 120 },
      ],
    },
    loading: {},
    truncated: {},
    errors: {},
    hidden: true,
  });
}

function setUA(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

const PLAIN_UA = "Mozilla/5.0 (Macintosh) Chrome/120";
const APP_UA = "Mozilla/5.0 (iPhone) FNAppType/ios FNAppVer/1.38.0";

beforeEach(() => {
  seed();
  setUA(PLAIN_UA);
});

afterEach(() => {
  setUA(PLAIN_UA);
});

describe("FilesPanel 行菜单", () => {
  it("不在宿主里时只有「复制文件路径」", () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("更多操作 README.md"));

    expect(screen.getByRole("menuitem", { name: /复制文件路径/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /在文件夹显示/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /文件详情/ })).toBeNull();
  });

  it("目录的复制项叫「复制文件夹路径」", () => {
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("更多操作 src"));
    expect(screen.getByRole("menuitem", { name: /复制文件夹路径/ })).toBeInTheDocument();
  });

  it("在飞牛 App 里给全三项", () => {
    setUA(APP_UA);
    render(<FilesPanel cwd={CWD} active />);
    fireEvent.click(screen.getByLabelText("更多操作 README.md"));

    expect(screen.getByRole("menuitem", { name: /在文件夹显示/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /复制文件路径/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /文件详情/ })).toBeInTheDocument();
  });
});
