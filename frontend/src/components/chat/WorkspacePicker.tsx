// 新建对话页的工作区选择器：输入框上方那一枚胶囊。
//
// 对话一旦建立就绑定了 cwd，所以这个入口只在「还没有对话」的空态出现；
// 选中的工作区既决定新会话的 cwd，也决定侧栏高亮，两者必须同步（走
// store.setCurrentWorkspace，而不是只改本地 state）。

import { useState } from "react";
import type { WorkspaceEntry } from "../../transport/types";
import { baseName } from "../../lib/labels";
import { useT } from "../../lib/i18n";
import { Menu, type MenuItem } from "../common/Menu";
import { IconCheck, IconChevronDown, IconFolder, IconFolderPlus } from "../common/Icons";

interface Props {
  workspaces: WorkspaceEntry[];
  current: string;
  disabled?: boolean;
  onPick: (path: string) => void;
  onAdd: () => void;
}

export function WorkspacePicker({ workspaces, current, disabled = false, onPick, onAdd }: Props) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const label = current ? (workspaces.find((w) => w.path === current)?.name || baseName(current)) : "";
  const items: MenuItem[] = [
    ...workspaces.map((w) => ({
      id: w.path,
      label: (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">{w.name || baseName(w.path)}</span>
          {w.path === current && <IconCheck size={12} className="ml-auto shrink-0 text-brand" />}
        </span>
      ),
      onSelect: () => onPick(w.path),
    })),
    {
      id: "__add",
      label: t("添加授权目录…", "Add a directory…"),
      icon: <IconFolderPlus size={13} />,
      onSelect: onAdd,
    },
  ];

  // 一个目录都没授权时没什么可选的，直接给「添加授权目录」入口。
  const empty = workspaces.length === 0;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => (empty ? onAdd() : setAnchor(e.currentTarget))}
        title={current || t("选择工作区", "Choose a workspace")}
        aria-label={t("工作区", "Workspace")}
        aria-haspopup={empty ? undefined : "menu"}
        aria-expanded={empty ? undefined : anchor !== null}
        className="flex max-w-full items-center gap-1.5 rounded-full bg-panel-strong/70 px-2.5 py-1 text-[11.5px] text-ink-2 hover:bg-panel-strong disabled:opacity-40"
      >
        {empty ? <IconFolderPlus size={13} className="shrink-0 text-muted" /> : <IconFolder size={13} className="shrink-0 text-muted" />}
        <span className="max-w-[12rem] truncate">{empty ? t("添加授权目录", "Add directory") : label || t("选择工作区", "Choose a workspace")}</span>
        {!empty && <IconChevronDown size={12} className="shrink-0 text-faint" />}
      </button>
      <Menu open={anchor !== null} anchor={anchor} items={items} onClose={() => setAnchor(null)} width={248} align="start" />
    </>
  );
}
