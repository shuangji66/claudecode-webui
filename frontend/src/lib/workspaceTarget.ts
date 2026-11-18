// 「项目级配置写到哪个工作区」的共用规则：MCP 与技能两个设置页都用它。
//
// 两页的共同点：项目级文件（`.mcp.json` / `.claude/skills`）都长在工作区根上，
// 而「当前对话在哪个工作区」只是个经验默认值——多工作区下用户经常要把配置加到
// 另一个目录里。所以选择权在界面上的下拉，cwd 只在用户没选过时提供默认值。

import { workspaceFor } from "./conversations";
import { baseName } from "./labels";
import type { WorkspaceEntry } from "../transport/types";

/** 下拉选项：显示名与目录末段重名时只显示一次，否则并排给出（两个同名工作区才分得清）。 */
export function workspaceOptions(workspaces: WorkspaceEntry[]): { value: string; label: string }[] {
  return workspaces.map((w) => ({
    value: w.path,
    label: w.name && w.name !== baseName(w.path) ? `${w.name}（${baseName(w.path)}）` : baseName(w.path),
  }));
}

/**
 * 默认目标工作区：会话 cwd 正好是某个工作区就用它，否则取它所属的工作区
 * （对话 cwd 可能是工作区子目录），再否则第一个已授权目录。
 *
 * 没有已授权目录时返回空串——这时候项目级配置无处落盘，界面要明说而不是
 * 拿一个未授权的 cwd 去请求（那只会得到一个 400）。
 */
export function initialTarget(cwd: string, workspaces: WorkspaceEntry[]): string {
  if (cwd) {
    if (workspaces.some((w) => w.path === cwd)) return cwd;
    const owner = workspaceFor(cwd, workspaces);
    if (owner) return owner;
  }
  return workspaces[0]?.path ?? "";
}
