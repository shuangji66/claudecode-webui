// 「设置 → 技能 → 导入」：一次把多个技能灌进个人技能目录或某个工作区。
//
// 两条来源：
//   1. 浏览器里挑的文件 / 文件夹——内容在手里，逐条走 PUT /api/skills/doc；
//   2. 飞牛选择器挑的 NAS 路径——内容由后端读（只认 SKILL.md），走
//      POST /api/skills/import，前端不碰宿主文件。
//
// 目标工作区与页面上的那个下拉是同一个状态：这里换了，背后的列表也跟着切，
// 保存时写的就是用户眼前那个 `.claude/skills`。

import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { pickFnosFiles } from "../../lib/fnos";
import {
  MAX_IMPORT,
  isSkillFile,
  skillNameFromPath,
  stripMarkdownExt,
  validSkillName,
  type ImportDraft,
} from "../../lib/skillsImport";
import { workspaceOptions } from "../../lib/workspaceTarget";
import { useSkillsStore } from "../../store/useSkillsStore";
import type { SkillImportResult, SkillScope, WorkspaceEntry } from "../../transport/types";
import { Button } from "../common/Button";
import { Dialog } from "../common/Dialog";
import { Select } from "../common/Select";
import { IconAlert, IconClose, IconDownload, IconFolder, IconFile, IconRefresh } from "../common/Icons";

let seq = 0;
const nextId = () => `imp-${++seq}`;

function humanSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 页面当前选中的工作区，以及改它的回调。 */
  target: string;
  onTargetChange: (path: string) => void;
  /** 列表里已存在的技能名，用来标「将覆盖」。 */
  existing: { personal: string[]; project: string[] };
  workspaces: WorkspaceEntry[];
  /**
   * 导入完成后的结果（含逐条失败原因）。
   *
   * 弹窗自己会立刻关掉——批量导入不是「看着进度条等」的操作，结果由调用方
   * 在页面上给一条可读的提示（失败的技能名与原因都在这里）。
   */
  onImported?: (results: SkillImportResult[]) => void;
}

export function SkillImportDialog({ open, onClose, target, onTargetChange, existing, workspaces, onImported }: Props) {
  const t = useT();
  const importEntries = useSkillsStore((s) => s.importEntries);
  const importFromPaths = useSkillsStore((s) => s.importFromPaths);

  const [scope, setScope] = useState<SkillScope>("personal");
  const [items, setItems] = useState<ImportDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  // 每次打开都是新的一次导入：上一轮的结果与清单不应该残留。
  useEffect(() => {
    if (!open) return;
    setItems([]);
    setError(null);
    setScope("personal");
  }, [open]);

  const options = workspaceOptions(workspaces);
  const needingTarget = scope === "project" && !target;
  const existingNames = new Set((scope === "project" ? existing.project : existing.personal).map((n) => n));
  const nameCounts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.name] = (acc[item.name] ?? 0) + 1;
    return acc;
  }, {});

  const addLocal = async (files: FileList | null, fromFolder: boolean) => {
    if (!files || files.length === 0) return;
    const room = MAX_IMPORT - items.length;
    if (room <= 0) {
      setError(t(`一次最多导入 ${MAX_IMPORT} 个技能`, `At most ${MAX_IMPORT} skills per import`));
      return;
    }
    const picked = Array.from(files)
      .filter((f) => isSkillFile(fromFolder ? (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name : f.name, fromFolder))
      .slice(0, room);
    if (picked.length === 0) {
      setError(
        fromFolder
          ? t("这个文件夹里没有 SKILL.md", "No SKILL.md found in that folder")
          : t("只支持 .md / .markdown 文件", "Only .md / .markdown files are supported"),
      );
      return;
    }
    const drafts: ImportDraft[] = [];
    // 读取失败不能静默跳过：只 setError 之后又被下面的 setError(null) 清掉的话，
    // 用户会看到「选了两个、清单里只有一个」而没有任何解释。
    const failed: string[] = [];
    for (const file of picked) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
      try {
        const content = await file.text();
        drafts.push({
          id: nextId(),
          name: skillNameFromPath(rel || file.name),
          size: file.size,
          kind: "local",
          content,
        });
      } catch (e) {
        failed.push(`${rel || file.name}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (drafts.length > 0) setItems((prev) => [...prev, ...drafts]);
    if (failed.length > 0) {
      // 成功的照常进清单，失败的把文件名与原因说清楚（最多列三条，其余只报数量）。
      const shown = failed.slice(0, 3).join("；");
      const more = failed.length > 3 ? `…（共 ${failed.length} 个）` : "";
      setError(t(`有文件读不出来：${shown}${more}`, `Could not read: ${shown}${more}`));
      return;
    }
    setError(null);
  };

  const addFromFnos = async () => {
    setError(null);
    // 让选择器只列 markdown：技能只可能是 .md，混进图片/压缩包没有任何意义。
    const res = await pickFnosFiles({ title: t("选择 SKILL.md", "Pick SKILL.md"), accept: [".md", ".markdown"] });
    if (res.state === "skipped") {
      setError(
        res.reason === "standalone"
          ? t("当前不在飞牛宿主中，请改用「选择文件」", "Not inside the fnOS host — use “Choose files” instead")
          : t("飞牛宿主连接不可用，请改用「选择文件」", "The fnOS bridge is unavailable — use “Choose files” instead"),
      );
      return;
    }
    if (res.state === "denied") {
      if (res.reason === "message") setError(res.message);
      return;
    }
    const paths = res.paths.filter((p) => isSkillFile(p, true));
    if (paths.length === 0) {
      setError(t("选中的文件里没有 SKILL.md", "None of the picked files is SKILL.md"));
      return;
    }
    const room = MAX_IMPORT - items.length;
    if (room <= 0) {
      setError(t(`一次最多导入 ${MAX_IMPORT} 个技能`, `At most ${MAX_IMPORT} skills per import`));
      return;
    }
    setItems((prev) => [
      ...prev,
      ...paths.slice(0, room).map((path) => ({
        id: nextId(),
        name: skillNameFromPath(path),
        size: 0,
        kind: "path" as const,
        path,
      })),
    ]);
  };

  const drop = (id: string) => setItems((prev) => prev.filter((item) => item.id !== id));

  const submit = async () => {
    if (items.length === 0) return;
    if (needingTarget) {
      setError(t("先选一个工作区，才能导入项目技能", "Pick a workspace first to import project skills"));
      return;
    }
    // 名字是空的条目**不许静默丢弃**：导入按钮上写着「导入 N 个」，少导一个却不说，
    // 用户只会以为导入坏了。宁可拦住，让他把那个红框填掉或删掉。
    const unnamed = items.filter((item) => item.name.trim() === "").length;
    if (unnamed > 0) {
      setError(
        unnamed === items.length
          ? t("给每个技能填一个名字", "Give every skill a name")
          : t(`还有 ${unnamed} 个条目没填技能名`, `${unnamed} entr${unnamed === 1 ? "y has" : "ies have"} no skill name yet`),
      );
      return;
    }
    const named = items;
    if (named.some((item) => !validSkillName(item.name.trim()))) {
      setError(t("技能名不能包含 / \\ < >，不能以点开头，也不能超过 64 字节", "Names cannot contain / \\ < >, start with a dot, or exceed 64 bytes"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const local = named.filter((item) => item.kind === "local");
      const remote = named.filter((item) => item.kind === "path");
      const out: SkillImportResult[] = [];
      if (local.length > 0) {
        out.push(...(await importEntries(scope, local.map((item) => ({ name: item.name.trim(), content: item.content ?? "" })))));
      }
      if (remote.length > 0) {
        out.push(...(await importFromPaths(scope, remote.map((item) => item.path ?? ""))));
      }
      // 导入是一次性动作，弹窗随即关闭；结果交给页面显示（失败的技能名与原因都在里面）。
      onImported?.(out);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("导入技能", "Import skills")}
      title={t("导入技能", "Import skills")}
      size="md"
      bodyClassName="px-4 py-3.5"
      footer={
        // 不放「关闭」：右上角 × 与 Esc 已经能取消，导入成功后弹窗自己关。
        <div className="flex justify-end">
          <Button variant="primary" disabled={busy || items.length === 0 || needingTarget} onClick={() => void submit()}>
            {busy ? t("导入中…", "Importing…") : t(`导入 ${items.length} 个`, `Import ${items.length}`)}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[8.5rem] shrink-0">
            <span className="mb-1 block text-[11.5px] text-muted">{t("导入到", "Import to")}</span>
            <Select
              ariaLabel={t("导入作用域", "Import scope")}
              value={scope}
              onChange={(v) => setScope(v as SkillScope)}
              options={[
                { value: "personal", label: t("个人技能", "Personal") },
                { value: "project", label: t("项目技能", "Project") },
              ]}
            />
          </div>
          {scope === "project" && (
            <div className="min-w-0 flex-1">
              <span className="mb-1 block text-[11.5px] text-muted">{t("工作区", "Workspace")}</span>
              {options.length > 0 ? (
                <Select
                  ariaLabel={t("目标工作区", "Target workspace")}
                  value={target}
                  onChange={onTargetChange}
                  options={options}
                  placeholder={t("先选工作区", "Pick a workspace")}
                />
              ) : (
                <p className="px-1 py-1.5 text-[11.5px] text-faint">{t("还没有授权目录。", "No workspaces yet.")}</p>
              )}
            </div>
          )}
        </div>
        <p className="truncate font-mono text-[10.5px] text-faint" title={scope === "project" ? (target ? `${target}/.claude/skills` : "") : undefined}>
          {scope === "project"
            ? target
              ? t(`写入 ${target}/.claude/skills`, `Writes to ${target}/.claude/skills`)
              : t("先选一个工作区，才能导入项目技能", "Pick a workspace first to import project skills")
            : t("写入个人技能目录（所有会话可见）", "Writes to the personal skills directory (all sessions)")}
        </p>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" icon={<IconFile size={13} />} onClick={() => fileRef.current?.click()} disabled={busy}>
            {t("选择文件", "Choose files")}
          </Button>
          <Button size="sm" variant="secondary" icon={<IconFolder size={13} />} onClick={() => dirRef.current?.click()} disabled={busy}>
            {t("选择文件夹", "Choose folder")}
          </Button>
          <Button size="sm" variant="secondary" icon={<IconDownload size={13} />} onClick={() => void addFromFnos()} disabled={busy}>
            {t("从飞牛选择", "Pick from fnOS")}
          </Button>
          {items.length > 0 && (
            <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => setItems([])} disabled={busy}>
              {t("清空", "Clear")}
            </Button>
          )}
        </div>
        <p className="text-[10.5px] leading-relaxed text-faint">
          {t(
            "选文件夹时只收每个技能目录里的 SKILL.md；直接选文件支持任意 .md。同名技能会被覆盖。",
            "Folder picks only take each skill's SKILL.md; file picks accept any .md. Existing skills with the same name are overwritten.",
          )}
        </p>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".md,.markdown,text/markdown"
          aria-label={t("选择技能文件", "Choose skill files")}
          className="hidden"
          onChange={(e) => {
            void addLocal(e.target.files, false);
            e.target.value = "";
          }}
        />
        <input
          ref={dirRef}
          type="file"
          multiple
          aria-label={t("选择技能文件夹", "Choose skill folder")}
          className="hidden"
          // 目录选择：React 没有类型，用展开塞进去（Chromium/WebKit 都认）。
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(e) => {
            void addLocal(e.target.files, true);
            e.target.value = "";
          }}
        />

        {error && (
          <div className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11.5px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
            <IconAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {items.length > 0 && (
          <div className="dsh-scroll max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {items.map((item) => {
              const name = item.name.trim();
              const bad = name === "" || !validSkillName(name);
              const dup = name !== "" && (nameCounts[name] ?? 0) > 1;
              const cover = name !== "" && existingNames.has(name);
              return (
                <div key={item.id} className="flex items-center gap-1.5 rounded-lg border border-line bg-panel/40 px-2 py-1.5">
                  <input
                    value={item.name}
                    onChange={(e) => setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, name: e.target.value } : it)))}
                    placeholder={t("技能名", "Skill name")}
                    aria-label={t("技能名", "Skill name")}
                    className={`min-w-0 flex-1 rounded-md border bg-canvas px-2 py-1 font-mono text-[11.5px] text-ink outline-none focus-visible:border-brand/60 ${
                      bad ? "border-danger" : "border-line-strong"
                    }`}
                  />
                  {dup && <span className="shrink-0 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-warn dark:bg-amber-950/30">{t("重名", "Dup")}</span>}
                  {cover && <span className="shrink-0 rounded bg-panel-strong px-1 py-0.5 text-[10px] text-muted">{t("覆盖", "Overwrite")}</span>}
                  <span className="shrink-0 font-mono text-[10px] text-faint" title={item.path}>
                    {item.kind === "path" ? stripMarkdownExt(item.path?.split("/").pop() ?? "") : humanSize(item.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={t("移除", "Remove")}
                    onClick={() => drop(item.id)}
                    className="shrink-0 rounded p-1 text-faint transition hover:bg-black/5 hover:text-ink"
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[10.5px] leading-relaxed text-faint">
          {t("技能改完立即生效，无需重开会话。", "Skills apply immediately, no restart needed.")}
        </p>
      </div>
    </Dialog>
  );
}
