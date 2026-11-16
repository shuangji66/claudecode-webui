// 「设置 → 技能」：claude 的 SKILL.md 管理。
//
// 只做文件层面：个人技能（claude home 下，所有会话可见）与项目技能
// （仓库里的 .claude/skills，随提交共享）。claude.ai 同步来的技能只读列出；
// 插件技能与 bundled 技能的开关不在这里，归 `claude plugin` 与 settings.json。
//
// 改完不需要重启会话：claude 会监听这几个目录，当前会话内即生效。

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { useSkillsStore } from "../../store/useSkillsStore";
import type { SkillEntry, SkillScope } from "../../transport/types";
import { Button } from "../common/Button";
import { askConfirm } from "../common/SystemDialogs";
import { IconPlus, IconRefresh, IconTrash, IconWrench } from "../common/Icons";

/** 新建技能时的骨架：description 是 claude 判断「何时自动加载」的唯一依据。 */
const TEMPLATE = `---
description: 说明这个技能做什么、什么时候该用它。
---

## 步骤

1. 
`;

export function SkillsSettings({ cwd }: { cwd: string }) {
  const t = useT();
  const data = useSkillsStore((s) => s.data);
  const doc = useSkillsStore((s) => s.doc);
  const error = useSkillsStore((s) => s.error);
  const busy = useSkillsStore((s) => s.busy);
  const load = useSkillsStore((s) => s.load);
  const read = useSkillsStore((s) => s.read);
  const save = useSkillsStore((s) => s.save);
  const remove = useSkillsStore((s) => s.remove);
  const clearDoc = useSkillsStore((s) => s.clearDoc);
  const setError = useSkillsStore((s) => s.setError);

  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = doc !== null && draft !== doc.content;
  const readOnly = doc?.read_only === true;

  useEffect(() => {
    void load(cwd);
  }, [cwd, load]);

  const open = async (scope: SkillScope, name: string) => {
    if (dirty && !(await askConfirm({ title: t("放弃未保存的修改？", "Discard unsaved changes?"), danger: true }))) return;
    setCreating(false);
    setSavedAt(null);
    const next = await read(scope, name);
    if (next) setDraft(next.content);
  };

  const startCreate = () => {
    clearDoc();
    setCreating(true);
    setNameDraft("");
    setDraft(TEMPLATE);
    setSavedAt(null);
  };

  const cancel = () => {
    setCreating(false);
    setDraft("");
    setNameDraft("");
    clearDoc();
  };

  const submit = async () => {
    const scope: SkillScope = creating ? "personal" : doc?.scope ?? "personal";
    const name = creating ? nameDraft.trim() : doc?.name ?? "";
    if (!name) {
      setError(t("先给技能起个名字（会成为 /命令名）", "Give the skill a name first (it becomes the /command)"));
      return;
    }
    const next = await save(scope, name, draft);
    if (!next) return;
    setDraft(next.content);
    setCreating(false);
    setSavedAt(Date.now());
  };

  const confirmRemove = async () => {
    if (!doc || readOnly) return;
    const ok = await askConfirm({
      title: t(`删除技能「${doc.name}」？`, `Delete skill "${doc.name}"?`),
      message: t("整个技能目录都会被删除，无法撤销。", "The whole skill directory is removed. This cannot be undone."),
      danger: true,
    });
    if (!ok) return;
    if (await remove(doc.scope, doc.name)) {
      setDraft("");
      setSavedAt(null);
    }
  };

  const group = (label: string, hint: string, items: SkillEntry[], scope: SkillScope) => (
    <div className="mb-4">
      <div className="flex items-baseline gap-1.5 px-1">
        <h4 className="text-[11.5px] font-medium text-ink">{label}</h4>
        <span className="text-[10.5px] text-faint">{items.length}</span>
      </div>
      <p className="mt-0.5 px-1 text-[10.5px] leading-relaxed text-faint">{hint}</p>
      <div className="mt-1.5 space-y-0.5">
        {items.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] text-faint">{t("暂无", "None")}</p>
        ) : (
          items.map((item) => {
            const active = doc?.scope === item.scope && doc?.name === item.name;
            return (
              <button
                key={`${item.scope}/${item.name}`}
                type="button"
                onClick={() => void open(item.scope, item.name)}
                className={`flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left transition ${
                  active ? "bg-panel-strong text-ink" : "text-muted hover:bg-black/5 hover:text-ink"
                }`}
              >
                <IconWrench size={13} className={active ? "mt-0.5 shrink-0 text-brand" : "mt-0.5 shrink-0 text-faint"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px]">{item.name}</span>
                  {item.description && (
                    <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-snug text-faint">{item.description}</span>
                  )}
                  {item.invalid && <span className="mt-0.5 block text-[10.5px] text-danger">{item.invalid}</span>}
                </span>
                {item.read_only && <span className="shrink-0 rounded bg-black/5 px-1 text-[9.5px] text-faint">{t("只读", "RO")}</span>}
              </button>
            );
          })
        )}
      </div>
      {scope === "project" && !cwd && (
        <p className="mt-1 px-1 text-[10.5px] text-faint">{t("先选择一个工作区才能管理项目技能", "Pick a workspace to manage project skills")}</p>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{t("技能", "Skills")}</h3>
        <span className="text-[10.5px] text-faint">{data.personal.length + data.project.length + data.synced.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => void load(cwd)} disabled={busy}>
            {t("刷新", "Refresh")}
          </Button>
          <Button size="sm" variant="secondary" icon={<IconPlus size={13} />} onClick={startCreate} disabled={busy}>
            {t("新建", "New")}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {t(
          "技能就是 SKILL.md：Claude 按 description 自动调用，也可以直接输入 /名字。改完当前会话即生效，无需重启。",
          "A skill is a SKILL.md: Claude invokes it from the description, or you type /name. Changes apply live, no restart.",
        )}
      </p>
      {error && <p className="mt-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">{error}</p>}

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <div className="dsh-scroll shrink-0 overflow-y-auto pb-4 md:w-[218px] md:border-r md:border-line md:pr-3">
          {group(t("个人", "Personal"), t("所有会话可见，存在数据目录里", "All sessions, stored in the data dir"), data.personal, "personal")}
          {group(t("项目", "Project"), t("跟着仓库走，可提交共享", "Shipped with the repo, commit to share"), data.project, "project")}
          {data.synced.length > 0 &&
            group(t("claude.ai 同步", "Synced from claude.ai"), t("只读，在 claude.ai 上改", "Read-only, edit on claude.ai"), data.synced, "synced")}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {creating ? (
            <>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder={t("技能名（会成为 /命令名）", "Skill name (becomes /command)")}
                  className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-brand/60"
                />
                <span className="shrink-0 text-[10.5px] text-faint">{t("个人技能", "Personal")}</span>
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="dsh-scroll mt-2 min-h-[220px] flex-1 resize-none rounded-lg border border-line-strong bg-canvas p-2.5 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus:border-brand/60"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void submit()} disabled={busy || !nameDraft.trim()}>
                  {t("创建", "Create")}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancel}>
                  {t("取消", "Cancel")}
                </Button>
              </div>
            </>
          ) : doc ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-[12.5px] font-medium text-ink">/{doc.name}</span>
                <span className="text-[10.5px] text-faint">
                  {doc.scope === "personal" ? t("个人", "Personal") : doc.scope === "project" ? t("项目", "Project") : t("同步", "Synced")}
                </span>
                <span className="truncate font-mono text-[10.5px] text-faint" title={doc.path}>
                  {doc.path}
                </span>
                <span className="ml-auto text-[10.5px] text-faint">
                  {busy ? t("保存中…", "Saving…") : dirty ? t("未保存", "Unsaved") : savedAt ? t("已保存", "Saved") : ""}
                </span>
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                readOnly={readOnly}
                spellCheck={false}
                className="dsh-scroll mt-2 min-h-[220px] flex-1 resize-none rounded-lg border border-line-strong bg-canvas p-2.5 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus:border-brand/60 read-only:opacity-70"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void submit()} disabled={busy || readOnly || !dirty}>
                  {t("保存", "Save")}
                </Button>
                {!readOnly && (
                  <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} onClick={() => void confirmRemove()} disabled={busy}>
                    {t("删除", "Delete")}
                  </Button>
                )}
                <span className="ml-auto text-[10.5px] text-faint">{readOnly ? t("该来源只读", "Read-only source") : ""}</span>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
              <IconWrench size={18} className="text-faint" />
              <p className="text-[12px] text-muted">{t("从左边选一个技能，或新建一个", "Pick a skill on the left, or create one")}</p>
              <p className="max-w-sm text-[10.5px] leading-relaxed text-faint">
                {t("个人技能对所有会话生效；项目技能跟着仓库走。", "Personal skills apply to every session; project skills travel with the repo.")}
              </p>
              {data.personal_root && <p className="max-w-full break-all font-mono text-[10px] text-faint">{data.personal_root}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
