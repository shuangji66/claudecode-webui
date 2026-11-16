import { describe, expect, it } from "vitest";
import { guardAutofill, installAutofillGuard } from "./autofill";

describe("autofill guard", () => {
  it("给输入框加禁用自动填充属性，密码框用 new-password", () => {
    const root = document.createElement("div");
    root.innerHTML = `<input id="url" /><input id="pwd" type="password" /><textarea id="ta"></textarea>`;
    guardAutofill(root);
    expect(root.querySelector("#url")!.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector("#pwd")!.getAttribute("autocomplete")).toBe("new-password");
    expect(root.querySelector("#ta")!.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector("#url")!.getAttribute("data-lpignore")).toBe("true");
    expect(root.querySelector("#pwd")!.getAttribute("data-form-type")).toBe("other");
  });

  it("动态插入的输入框也会被处理", async () => {
    const stop = installAutofillGuard(document);
    const input = document.createElement("input");
    document.body.appendChild(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.getAttribute("autocomplete")).toBe("off");
    input.remove();
    stop();
  });
});
