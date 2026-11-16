import { describe, expect, it } from "vitest";
import { NO_AUTOFILL, guardAutofill, installAutofillGuard } from "./autofill";

describe("autofill guard", () => {
  it("给输入框加禁用自动填充属性，密码框用 new-password", () => {
    const root = document.createElement("div");
    root.innerHTML = `<input id="url" /><input id="pwd" type="password" /><textarea id="ta"></textarea>`;
    guardAutofill(root);
    expect(root.querySelector("#url")!.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector("#pwd")!.getAttribute("autocomplete")).toBe("new-password");
    expect(root.querySelector("#ta")!.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector("#url")!.getAttribute("data-lpignore")).toBe("true");
    expect(root.querySelector("#url")!.getAttribute("data-dashlane-ignore")).toBe("true");
    expect(root.querySelector("#pwd")!.getAttribute("data-form-type")).toBe("other");
    expect(root.querySelector("#pwd")!.getAttribute("data-1p-ignore")).toBe("true");
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

describe("NO_AUTOFILL 静态属性", () => {
  it("覆盖主流密码管理器的忽略标记", () => {
    expect(NO_AUTOFILL).toMatchObject({
      autoComplete: "off",
      "data-1p-ignore": "true",
      "data-lpignore": "true",
      "data-bwignore": "true",
      "data-dashlane-ignore": "true",
      "data-protonpass-ignore": "true",
      "data-form-type": "other",
    });
  });
});
