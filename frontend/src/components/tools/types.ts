import type { ComponentType } from "react";
import type { ToolItem } from "../../lib/model";

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
  /** 显示名；Agent 取任务描述，所以带 item。 */
  title: (item: ToolItem, t: (zh: string, en?: string) => string) => string;
  Card: ComponentType<{ item: ToolItem }>;
  Body: ComponentType<{ item: ToolItem }>;
}
