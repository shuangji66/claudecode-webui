import { describe, expect, it } from "vitest";
import { passwordIssue } from "./password";

describe("passwordIssue", () => {
  it("接受 8 位以上、含字母与数字的密码", () => {
    expect(passwordIssue("s3cret-123")).toBeNull();
    expect(passwordIssue("密码abc12345")).toBeNull();
  });

  it("长度不足", () => {
    expect(passwordIssue("ab12")).toBe("short");
  });

  it("只有字母或只有数字", () => {
    expect(passwordIssue("allletters")).toBe("digit");
    expect(passwordIssue("12345678")).toBe("letter");
  });

  it("拒绝控制字符", () => {
    expect(passwordIssue("abc12345\n")).toBe("control");
  });

  it("拒绝超长密码", () => {
    expect(passwordIssue("a1".repeat(70))).toBe("long");
  });
});
