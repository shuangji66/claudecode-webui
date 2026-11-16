// 危险权限模式：`不询问`（dontAsk）与 `跳过权限`（bypassPermissions）。
//
// 这两个模式会让 claude 直接执行命令、不再弹审批。菜单里必须标红，
// 切换前必须二次确认并给一句人话解释——误选的代价是不可撤销的（命令已经跑了）。

import type { Locale } from "./i18n";

/** 需要标红 + 二次确认的模式。 */
export const DANGEROUS_PERMISSION_MODES = ["dontAsk", "bypassPermissions"] as const;

export function isDangerousPermissionMode(mode: string | undefined): boolean {
  return mode === "dontAsk" || mode === "bypassPermissions";
}

/** 二次确认弹窗的标题与一句话说明（按模式区分，别让用户猜）。 */
export function permissionModeWarning(
  mode: string,
  locale: Locale = "zh",
): { title: string; message: string } {
  if (mode === "dontAsk") {
    return locale === "en"
      ? {
          title: 'Switch to "Don\'t ask"?',
          message:
            "Claude stops asking for permission: only operations already allowed by your settings run, everything else is denied.",
        }
      : {
          title: "切换到「不询问」？",
          message: "claude 不再弹审批：只有设置里已允许的操作会执行，其余会被直接拒绝。",
        };
  }
  if (mode === "bypassPermissions") {
    return locale === "en"
      ? {
          title: 'Switch to "Bypass permissions"?',
          message:
            "Every permission check is skipped and any command runs immediately. Only use this in a workspace you fully trust.",
        }
      : {
          title: "切换到「跳过权限」？",
          message: "所有权限检查都会被跳过，任何命令都会立刻执行。请只在完全信任的工作区里使用。",
        };
  }
  return { title: "", message: "" };
}
