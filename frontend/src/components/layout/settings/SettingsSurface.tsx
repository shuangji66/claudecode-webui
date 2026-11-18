// 「设置式」模态的外壳：设置抽屉与功能弹窗（插件 / MCP / 技能中心）共用同一份
// 面板尺寸、圆角、移动端全屏与内边距，改一处两边一起变——不要再各写一份
// `Dialog ... panelClassName="h-[100dvh] ..."`。

import { Suspense, type ReactNode } from "react";
import { Dialog } from "../../common/Dialog";

/** 可整页滚动的页内容（通用 / 目录 / 插件 / 代理 / 部署 / 访问 / 关于）。 */
export const SETTINGS_PANE_SCROLL =
  "dsh-scroll h-full overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-4 md:px-8 md:pb-8 md:pt-6";

/** 自己管滚动的页内容（模型 / 技能 / MCP：页内有固定头部或分栏）。 */
export const SETTINGS_PANE_FLEX = "flex h-full min-h-0 flex-col px-4 pt-4 md:px-8 md:pt-6";

/** 桌面端与灯箱一致的尺寸（82vh / 900px），移动端铺满视口。 */
const SETTINGS_PANEL = "h-[100dvh] max-h-[100dvh] rounded-none md:h-[82vh] md:max-h-[84vh] md:rounded-2xl md:max-w-[900px]";

export function SettingsSurface({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={title}
      title={title}
      size="xl"
      bare
      fullScreen
      panelClassName={SETTINGS_PANEL}
    >
      {children}
    </Dialog>
  );
}

/** 一页内容：没打开过的页不挂载；切走只 hidden，滚动位置与表单状态都留着。 */
export function SettingsPane({
  active,
  mount,
  flex = false,
  children,
}: {
  active: boolean;
  mount: boolean;
  flex?: boolean;
  children: ReactNode;
}) {
  if (!mount) return null;
  return (
    <div className={active ? (flex ? SETTINGS_PANE_FLEX : SETTINGS_PANE_SCROLL) : "hidden"}>
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}
