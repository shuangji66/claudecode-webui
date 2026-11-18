// 「设置 → 技能」的数据层：/api/skills 的读写都收敛在这里。
//
// 单独开一个 store 而不是塞进 useAppStore：技能面板只在设置弹窗里用，
// 数据（列表/当前正文）跟着弹窗生命周期走，和会话/工作区状态无关。
// 组件不直接 fetch，规则与右侧栏的 useSidebarStore 一致。

import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import type { SkillDoc, SkillEntry, SkillImportResult, SkillScope, SkillsPayload } from "../transport/types";

const EMPTY: SkillsPayload = { personal: [], project: [], synced: [], project_root: "", personal_root: "" };

/** 后端保证返回数组，但异常响应不能把界面打白，这里兜一层。 */
export function normalizeSkills(p: SkillsPayload | null): SkillsPayload {
  if (!p) return EMPTY;
  return {
    personal: Array.isArray(p.personal) ? p.personal : [],
    project: Array.isArray(p.project) ? p.project : [],
    synced: Array.isArray(p.synced) ? p.synced : [],
    project_root: p.project_root ?? "",
    personal_root: p.personal_root ?? "",
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface SkillsState {
  /** 当前工作区；项目技能按它取。 */
  cwd: string;
  data: SkillsPayload;
  doc: SkillDoc | null;
  error: string | null;
  busy: boolean;

  load: (cwd: string) => Promise<void>;
  /** 读取正文；失败返回 null 并把原因放进 error。 */
  read: (scope: SkillScope, name: string) => Promise<SkillDoc | null>;
  /** 新建或覆盖；成功返回新正文。 */
  save: (scope: SkillScope, name: string, content: string) => Promise<SkillDoc | null>;
  remove: (scope: SkillScope, name: string) => Promise<boolean>;
  /**
   * 批量导入：内容已经在浏览器里（本地挑的文件）。
   *
   * 逐条 PUT 而不是并发：同名覆盖的顺序要可预期，失败也只会影响那一条。
   * 全部跑完才刷新一次列表——每个文件刷一次会把设置页打成一串请求。
   */
  importEntries: (scope: SkillScope, entries: { name: string; content: string }[]) => Promise<SkillImportResult[]>;
  /** 批量导入：来源在 NAS 上（飞牛选择器挑的目录 / SKILL.md），由后端读。 */
  importFromPaths: (scope: SkillScope, paths: string[]) => Promise<SkillImportResult[]>;
  clearDoc: () => void;
  setError: (msg: string | null) => void;
}

/** 项目技能的请求要带 cwd；个人/同步技能不带。 */
function query(state: SkillsState, scope: SkillScope, name?: string): string {
  const qs = new URLSearchParams({ scope });
  if (name) qs.set("name", name);
  if (scope === "project") qs.set("cwd", state.cwd);
  return qs.toString();
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  cwd: "",
  data: EMPTY,
  doc: null,
  error: null,
  busy: false,

  load: async (cwd) => {
    set({ busy: true, error: null, cwd });
    try {
      const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const data = normalizeSkills(await apiFetch<SkillsPayload>(`/api/skills${q}`));
      // 列表刷新后如果当前正文已被删掉，别让编辑器继续显示幽灵技能。
      const doc = get().doc;
      const alive = doc
        ? [...data.personal, ...data.project, ...data.synced].some((s: SkillEntry) => s.scope === doc.scope && s.name === doc.name)
        : true;
      set({ data, busy: false, doc: alive ? doc : null });
    } catch (e) {
      set({ error: errText(e), busy: false });
    }
  },

  read: async (scope, name) => {
    set({ busy: true, error: null });
    try {
      const doc = await apiFetch<SkillDoc>(`/api/skills/doc?${query(get(), scope, name)}`);
      set({ doc, busy: false });
      return doc;
    } catch (e) {
      set({ error: errText(e), busy: false, doc: null });
      return null;
    }
  },

  save: async (scope, name, content) => {
    set({ busy: true, error: null });
    try {
      const doc = await apiFetch<SkillDoc>("/api/skills/doc", {
        method: "PUT",
        body: JSON.stringify({ cwd: scope === "project" ? get().cwd : "", scope, name, content }),
      });
      set({ doc, busy: false });
      await get().load(get().cwd);
      return doc;
    } catch (e) {
      set({ error: errText(e), busy: false });
      return null;
    }
  },

  remove: async (scope, name) => {
    set({ busy: true, error: null });
    try {
      await apiFetch(`/api/skills/doc?${query(get(), scope, name)}`, { method: "DELETE" });
      set({ doc: null, busy: false });
      await get().load(get().cwd);
      return true;
    } catch (e) {
      set({ error: errText(e), busy: false });
      return false;
    }
  },

  importEntries: async (scope, entries) => {
    set({ busy: true, error: null });
    const cwd = scope === "project" ? get().cwd : "";
    const results: SkillImportResult[] = [];
    for (const item of entries) {
      try {
        await apiFetch<SkillDoc>("/api/skills/doc", {
          method: "PUT",
          body: JSON.stringify({ cwd, scope, name: item.name, content: item.content }),
        });
        results.push({ name: item.name, ok: true });
      } catch (e) {
        // 单条失败不中断：用户一次拖进十个技能，其中一个名字不合法时
        // 其余九个应该照旧导进去。
        results.push({ name: item.name, ok: false, error: errText(e) });
      }
    }
    set({ busy: false });
    await get().load(get().cwd);
    return results;
  },

  importFromPaths: async (scope, paths) => {
    set({ busy: true, error: null });
    try {
      const res = await apiFetch<{ results: SkillImportResult[]; saved: number }>("/api/skills/import", {
        method: "POST",
        body: JSON.stringify({ cwd: scope === "project" ? get().cwd : "", scope, paths }),
      });
      set({ busy: false });
      await get().load(get().cwd);
      return Array.isArray(res.results) ? res.results : [];
    } catch (e) {
      set({ error: errText(e), busy: false });
      return paths.map((path) => ({ path, ok: false, error: errText(e) }));
    }
  },

  clearDoc: () => set({ doc: null, error: null }),
  setError: (msg) => set({ error: msg }),
}));
