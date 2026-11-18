import type { ComponentType } from "react";
import type { ToolItem } from "../../lib/model";
import type { ToolStatus } from "./ToolShell";

/** 图标组件的最小契约（Icons.tsx 里的图标都满足）。 */
export interface ToolIconProps {
  size?: number;
  className?: string;
}

/**
 * 工具渲染注册项。
 *
 * `Card` 是「详细」模式的完整卡片，`Body` 是它展开后的正文（外壳由 ToolShell 提供）。
 * 两者共用同一份正文实现，避免紧凑行展开后出现第二个标题。
 */
export interface ToolRegistration {
  icon: ComponentType<ToolIconProps>;
  /**
   * 覆盖外壳默认的「运行中 / 完成 / 失败」措辞（紧凑模式用，详细模式的卡片自己传）。
   * 例：ExitPlanMode 的「等待批准 / 已通过 / 未通过」——它不是跑命令，没有「完成」这回事。
   */
  status?: (item: ToolItem, t: (zh: string, en?: string) => string) => ToolStatus;
  /** 显示名；Agent 取任务描述，所以带 item。 */
  title: (item: ToolItem, t: (zh: string, en?: string) => string) => string;
  Card: ComponentType<{ item: ToolItem }>;
  Body: ComponentType<{ item: ToolItem }>;
}
