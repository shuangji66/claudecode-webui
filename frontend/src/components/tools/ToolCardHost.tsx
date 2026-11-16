import type { ComponentType } from "react";
import type { ToolItem } from "../../lib/model";
import { AgentCard } from "./AgentCard";
import { BashCard } from "./BashCard";
import { EditCard } from "./EditCard";
import { GenericCard } from "./GenericCard";
import { WriteCard } from "./WriteCard";

/**
 * 工具渲染注册表。
 *
 * 必须保留兜底：claude 的工具集会随版本变化（2.1.325 实测 API 侧只下发 12 个工具，
 * 且有 ToolSearch / DeferredToolPlaceholder 这类动态工具），硬编码工具清单会让新工具
 * 渲染成空白。新增工具只需在这里加一行。
 */
const registry: Record<string, ComponentType<{ item: ToolItem }>> = {
  // 模型侧的工具名是 Agent（init 里显示为 Task），两个都注册。
  Agent: AgentCard,
  Task: AgentCard,
  Bash: BashCard,
  Edit: EditCard,
  // Write 的输入是 file_path/content，没有 old_string/new_string：走 EditCard 会
  // diff 构造失败、只显示一行 "File created successfully"，写入内容看不到。
  Write: WriteCard,
};

export function ToolCardHost({ item }: { item: ToolItem }) {
  const Card = registry[item.name] ?? GenericCard;
  return <Card item={item} />;
}

export { registry as __toolRegistry };
