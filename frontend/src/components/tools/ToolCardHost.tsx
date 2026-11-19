import type { ToolItem } from "../../lib/model";
import { IconChat, IconFileText, IconSpark, IconTerminal, IconWrench } from "../common/Icons";
import { useT } from "../../lib/i18n";
import { toolSummary } from "../../lib/tools";
import { AgentBody, AgentCard, agentLabel } from "./AgentCard";
import { AskQuestionBody, AskQuestionCard, askStatus } from "./AskQuestionCard";
import { BashBody, BashCard } from "./BashCard";
import { EditBody, EditCard } from "./EditCard";
import { GenericBody, GenericCard } from "./GenericCard";
import { PlanBody, PlanCard, planStatus } from "./PlanCard";
import { WriteBody, WriteCard } from "./WriteCard";
import { ToolShell } from "./ToolShell";
import type { ToolRegistration } from "./types";

/**
 * 工具渲染注册表。
 *
 * 必须保留兜底：claude 的工具集会随版本变化（2.1.325 实测 API 侧只下发 12 个工具，
 * 且有 ToolSearch / DeferredToolPlaceholder 这类动态工具），硬编码工具清单会让新工具
 * 渲染成空白。新增工具只需在这里加一行（Card = 详细模式，Body = 展开后的正文，
 * icon/title 只给紧凑模式的一行用，取值与 Card 的标题行保持一致）。
 */
const registry: Record<string, ToolRegistration> = {
  // 模型侧的工具名是 Agent（init 里显示为 Task），两个都注册。
  Agent: { icon: IconSpark, title: agentLabel, Card: AgentCard, Body: AgentBody },
  Task: { icon: IconSpark, title: agentLabel, Card: AgentCard, Body: AgentBody },
  Bash: { icon: IconTerminal, title: () => "Bash", Card: BashCard, Body: BashBody },
  Edit: { icon: IconWrench, title: () => "Edit", Card: EditCard, Body: EditBody },
  // Write 的输入是 file_path/content，没有 old_string/new_string：走 EditCard 会
  // diff 构造失败、只显示一行 "File created successfully"，写入内容看不到。
  Write: { icon: IconWrench, title: () => "Write", Card: WriteCard, Body: WriteBody },
  // 计划模式的最后一步：入参是一整份 Markdown 计划，按兜底卡片渲染等于让人读 JSON。
  ExitPlanMode: { icon: IconFileText, title: (_item, t) => t("计划", "Plan"), status: planStatus, Card: PlanCard, Body: PlanBody },
  // 模型中途的提问：实时作答在审批位置的 AskUserQuestionPanel，这张卡片只做回放
  // （问题、选项、用户的选择）。状态不复用「完成」——提问没有「运行」这回事。
  AskUserQuestion: { icon: IconChat, title: (_item, t) => t("提问", "Question"), status: askStatus, Card: AskQuestionCard, Body: AskQuestionBody },
};

/**
 * 工具卡片入口。
 *
 * `dense` 只影响外壳：一行标题 + 点开正文。正文与详细模式是同一份实现，
 * 所以紧凑行展开后不会出现第二个标题、也不会丢任何信息。
 */
export function ToolCardHost({ item, dense = false }: { item: ToolItem; dense?: boolean }) {
  const t = useT();
  const reg = registry[item.name];

  if (!dense) return reg ? <reg.Card item={item} /> : <GenericCard item={item} />;

  const title = reg ? reg.title(item, t) : item.name;
  const summary = toolSummary(item);
  return (
    <ToolShell
      item={item}
      dense
      icon={reg ? <reg.icon size={13} /> : <IconWrench size={13} />}
      title={title}
      subtitle={summary === title ? "" : summary}
      status={reg?.status?.(item, t)}
    >
      {reg ? <reg.Body item={item} /> : <GenericBody item={item} />}
    </ToolShell>
  );
}
