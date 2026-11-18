import { describe, expect, it } from "vitest";
import { isSkillFile, skillNameFromPath, stripMarkdownExt, validSkillName } from "./skillsImport";

describe("skillNameFromPath", () => {
  it("从技能目录里取目录名", () => {
    expect(skillNameFromPath("alpha/SKILL.md")).toBe("alpha");
    expect(skillNameFromPath("集合/a/SKILL.md")).toBe("a");
    expect(skillNameFromPath("/vol1/skills/beta/skill.md")).toBe("beta");
  });

  it("普通 md 文件用文件名", () => {
    expect(skillNameFromPath("my-skill.md")).toBe("my-skill");
    expect(skillNameFromPath("release.markdown")).toBe("release");
    expect(stripMarkdownExt("README.MD")).toBe("README");
  });

  it("光秃秃的 SKILL.md 叫不出名字，留给用户填", () => {
    expect(skillNameFromPath("SKILL.md")).toBe("");
  });
});

describe("isSkillFile", () => {
  it("选文件夹时只收 SKILL.md", () => {
    expect(isSkillFile("a/SKILL.md", true)).toBe(true);
    expect(isSkillFile("a/README.md", true)).toBe(false);
    expect(isSkillFile("a/run.sh", true)).toBe(false);
  });

  it("选文件时接受任意 markdown", () => {
    expect(isSkillFile("notes.md", false)).toBe(true);
    expect(isSkillFile("notes.txt", false)).toBe(false);
  });
});

describe("validSkillName", () => {
  it("挡掉路径穿越与隐藏目录", () => {
    for (const bad of ["", ".", "..", ".git", "a/b", "a\\b", "a<b", "a>b"]) {
      expect(validSkillName(bad), bad).toBe(false);
    }
  });

  it("按字节限制长度（与后端 len(name) 一致）", () => {
    expect(validSkillName("技".repeat(21))).toBe(true); // 63 字节
    expect(validSkillName("技".repeat(22))).toBe(false); // 66 字节
  });

  it("接受中文、空格与点号", () => {
    expect(validSkillName("部署到生产")).toBe(true);
    expect(validSkillName("my skill")).toBe(true);
    expect(validSkillName("v1.2")).toBe(true);
  });
});
