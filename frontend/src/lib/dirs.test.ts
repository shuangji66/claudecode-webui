import { describe, expect, it } from "vitest";
import { isProtectedDir } from "./dirs";

describe("isProtectedDir", () => {
  const app = "/vol1/@appdata/ClaudeCode";
  const data = "/vol1/@appdata/ClaudeCode/data";

  it("等于受保护目录时命中", () => {
    expect(isProtectedDir(app, [app])).toBe(true);
    expect(isProtectedDir(`${app}/`, [app])).toBe(true);
  });

  it("在受保护目录里面也命中（安装树里的文件同样是应用自己在用）", () => {
    expect(isProtectedDir(`${data}/logs`, [app])).toBe(true);
  });

  it("是受保护目录的祖先也命中（撤销父目录同样让应用读不到自己）", () => {
    expect(isProtectedDir("/vol1/@appdata", [app])).toBe(true);
    expect(isProtectedDir("/vol1", [data])).toBe(true);
  });

  it("只是名字前缀相同不算（/vol1/App2 不是 /vol1/App 的子路径）", () => {
    expect(isProtectedDir("/vol1/ClaudeCode2", [app])).toBe(false);
    expect(isProtectedDir("/vol1/ClaudeCode2/x", [app])).toBe(false);
  });

  it("无关路径、空输入与空列表都不命中", () => {
    expect(isProtectedDir("/vol1/home/user", [app, data])).toBe(false);
    expect(isProtectedDir("", [app])).toBe(false);
    expect(isProtectedDir("/vol1/home/user", [])).toBe(false);
    expect(isProtectedDir("/vol1/home/user", [""])).toBe(false);
  });

  // 根目录是任何绝对路径的祖先：撤销它等于把应用自己、数据目录的授权一起撤掉，
  // 而且界面再无入口恢复。旧写法把 `/` 归一成空串后早退返回 false，摆出了一颗
  // 点了就自断手脚的删除按钮。后端 protectedConflict 有同一套特例。
  it("根目录一律算受保护（后端 protectedConflict 同一条规则）", () => {
    expect(isProtectedDir("/", [app])).toBe(true);
    expect(isProtectedDir("/", [data])).toBe(true);
    expect(isProtectedDir("//", [app])).toBe(true);
  });

  it("受保护目录本身是根时，任何路径都命中", () => {
    expect(isProtectedDir("/vol1/anything", ["/"])).toBe(true);
  });
});
