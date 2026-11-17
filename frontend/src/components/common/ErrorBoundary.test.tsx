import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("渲染炸了");
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("组件抛错时显示兜底页，而不是整页空白", () => {
  // React 会把错误打到 console.error；这个用例本身就期望它发生。
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(screen.getByText("界面出错了")).toBeInTheDocument();
  expect(screen.getByText(/渲染炸了/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
});

it("正常渲染时不接管界面", () => {
  render(
    <ErrorBoundary>
      <p>内容</p>
    </ErrorBoundary>,
  );
  expect(screen.getByText("内容")).toBeInTheDocument();
  expect(screen.queryByText("界面出错了")).toBeNull();
});
