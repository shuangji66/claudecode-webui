import { useT } from "../../lib/i18n";
import { relativeTime } from "../../lib/labels";
import { HoverPreview } from "./HoverPreview";

/**
 * 侧栏工作区的悬浮概览：显示名 + 完整路径 + 对话数 / 最近使用。
 *
 * 参照 DSH 的工作区 hover 卡（标题、目录路径、时间）。我们这边没有工作区的创建时间
 * （`workspaces.json` 只记 `last_used`），所以报「最近使用」——不拿 last_used 冒充创建时间。
 */
export function WorkspacePreview({
  anchor,
  name,
  path,
  exists,
  count,
  lastUsed,
}: {
  anchor: HTMLElement;
  name: string;
  path: string;
  exists: boolean;
  /** 该工作区下的对话数。 */
  count: number;
  /** 最近活跃时间（打开过里面的对话、或把它设为当前工作区时刷新）。 */
  lastUsed?: string;
}) {
  const t = useT();
  const now = Date.now();
  const recent = lastUsed
    ? t(`最近使用 ${relativeTime(lastUsed, now, "zh")}`, `last used ${relativeTime(lastUsed, now, "en")}`)
    : "";
  const meta = [count > 0 ? t(`${count} 个对话`, `${count} conversations`) : t("暂无对话", "No conversations"), recent]
    .filter(Boolean)
    .join(" · ");

  return (
    <HoverPreview anchor={anchor}>
      <p className="truncate text-[12.5px] font-medium text-ink">{name}</p>
      <p className="mt-0.5 truncate text-[10.5px] text-faint" title={path}>
        {path}
      </p>
      <p className="mt-0.5 truncate text-[10.5px] text-faint">{meta}</p>
      {!exists && <p className="mt-1.5 text-[11px] text-warn">{t("目录不可用（被移动或卸载了）", "Directory missing (moved or unmounted)")}</p>}
    </HoverPreview>
  );
}
