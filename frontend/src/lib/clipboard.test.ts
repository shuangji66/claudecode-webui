import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("回退到 execCommand", async () => {
    const orig = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    await expect(copyText("hi")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    Object.defineProperty(navigator, "clipboard", { value: orig, configurable: true });
  });
});
