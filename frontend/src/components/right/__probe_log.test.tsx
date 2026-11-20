import { beforeEach, describe, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GitPanel } from "./GitPanel";
import { useSidebarStore } from "../../store/useSidebarStore";

let logCalls = 0;
const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(async (path: string): Promise<unknown> => {
    const url = new URL(path, "http://localhost");
    if (url.pathname.endsWith("/api/git/status")) return { is_repo: true, branch: "master", entries: [] };
    if (url.pathname.endsWith("/api/git/branches")) return { current: "master", names: ["master"] };
    if (url.pathname.endsWith("/api/git/log")) {
      (globalThis as unknown as { __logCalls: number }).__logCalls =
        ((globalThis as unknown as { __logCalls: number }).__logCalls ?? 0) + 1;
      return { entries: [] };
    }
    return {};
  }),
}));

vi.mock("../../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/runtime")>();
  return { ...actual, apiFetch };
});

const CWD = "/vol1/1000/demo";

beforeEach(() => {
  logCalls = 0;
  (globalThis as unknown as { __logCalls: number }).__logCalls = 0;
  useSidebarStore.setState({
    cwd: CWD,
    repo: "",
    repos: [],
    git: { is_repo: true, branch: "master", entries: [] },
    gitLoading: false,
    gitError: "",
    branches: { current: "master", names: ["master"] },
    log: [],
    logError: "",
    actionError: "",
  });
});

describe("probe: empty log", () => {
  it("does opening history in an empty repo loop?", async () => {
    render(<GitPanel cwd={CWD} active />);
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    await new Promise((r) => setTimeout(r, 300));
    // eslint-disable-next-line no-console
    console.log("git/log requests:", (globalThis as unknown as { __logCalls: number }).__logCalls);
    // eslint-disable-next-line no-console
    console.log("shows 还没有提交:", screen.queryByText("还没有提交。") !== null);
  });
});
