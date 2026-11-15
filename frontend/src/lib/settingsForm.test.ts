import { describe, expect, it } from "vitest";
import { EMPTY_FORM, buildPatch, formFromPublic, secretPlaceholder } from "./settingsForm";

describe("formFromPublic", () => {
  it("回填非密钥字段，密钥字段保持为空", () => {
    const f = formFromPublic({
      base_url: "https://relay.local",
      model: "m1",
      opus_model: "o1",
      sonnet_model: "s1",
      haiku_model: "h1",
      permission_mode: "acceptEdits",
      auto_compact_window: "200k",
      disable_unknown_model_window: true,
    });
    expect(f.baseUrl).toBe("https://relay.local");
    expect(f.model).toBe("m1");
    expect(f.permissionMode).toBe("acceptEdits");
    expect(f.autoCompactWindow).toBe("200k");
    expect(f.disableUnknownModelWindow).toBe(true);
    // 后端从不回传密钥，表单也不该有值
    expect(f.apiKey).toBe("");
    expect(f.authToken).toBe("");
  });
});

describe("buildPatch", () => {
  // 安全边界：密钥框留空时不能提交空串，否则「只改模型」会把已存密钥抹掉。
  it("空密钥不出现在补丁里", () => {
    const p = buildPatch({ ...EMPTY_FORM, model: "m2" });
    expect(p).not.toHaveProperty("api_key");
    expect(p).not.toHaveProperty("auth_token");
    expect(p.model).toBe("m2");
  });

  it("填了密钥才提交，并去空白", () => {
    const p = buildPatch({ ...EMPTY_FORM, apiKey: "  sk-ant-1  ", authToken: "tok" });
    expect(p.api_key).toBe("sk-ant-1");
    expect(p.auth_token).toBe("tok");
  });

  it("显式清除走 clear_* 标志", () => {
    const p = buildPatch({ ...EMPTY_FORM, apiKey: "sk-new" }, { apiKey: true, authToken: true });
    expect(p.clear_api_key).toBe(true);
    expect(p.clear_auth_token).toBe(true);
    // 同时提交新值 + 清除是矛盾输入，但后端按「先设后清」处理，这里只保证都带上
    expect(p.api_key).toBe("sk-new");
  });

  it("非密钥字段总是提交（允许清空）", () => {
    const p = buildPatch({ ...EMPTY_FORM, baseUrl: "", model: "", permissionMode: "" });
    expect(p.base_url).toBe("");
    expect(p.model).toBe("");
    expect(p.permission_mode).toBe("");
    // 高级项也要始终提交，否则用户清空窗口设置后无法保存
    expect(p.auto_compact_window).toBe("");
    expect(p.disable_unknown_model_window).toBe(false);
  });

  it("字段两侧空白被修剪", () => {
    const p = buildPatch({ ...EMPTY_FORM, baseUrl: "  https://x  ", model: "  m  " });
    expect(p.base_url).toBe("https://x");
    expect(p.model).toBe("m");
  });
});

describe("secretPlaceholder", () => {
  it("未设置与已设置给出不同提示", () => {
    expect(secretPlaceholder(false, "")).toBe("未设置");
    expect(secretPlaceholder(true, "sk-•••abcd")).toContain("已设置");
    expect(secretPlaceholder(true, "sk-•••abcd")).toContain("留空则不修改");
  });
});
