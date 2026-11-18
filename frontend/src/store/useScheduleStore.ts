// 「自动化任务」的数据层：/api/schedules 的读写都收敛在这里。
//
// 和 useSkillsStore 一样单独开一个 store：自动化任务面板是模态，数据跟着它走，
// 和会话/工作区状态无关。组件不直接 fetch。

import { create } from "zustand";
import { apiFetch } from "../lib/runtime";
import type { ScheduleDelivery, ScheduleRule, ScheduleTarget, ScheduleTask, SchedulesPayload } from "../transport/types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 后端保证返回数组，但异常响应不能把界面打白。 */
export function normalizeSchedules(p: SchedulesPayload | null): ScheduleTask[] {
  return Array.isArray(p?.tasks) ? p!.tasks : [];
}

/** 新建/修改任务的请求体（id 为空表示新建）。 */
export interface ScheduleDraft {
  id?: string;
  name: string;
  prompt: string;
  target: ScheduleTarget;
  workspace: string;
  rule: ScheduleRule;
  /** 修改时带上界面读到的那一版；后端用它做乐观并发（对不上回 409）。 */
  expected_updated_at?: string;
}

interface ScheduleState {
  tasks: ScheduleTask[];
  error: string | null;
  loading: boolean;
  saving: boolean;

  load: () => Promise<void>;
  save: (draft: ScheduleDraft) => Promise<ScheduleTask | null>;
  action: (id: string, action: "pause" | "resume" | "run") => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  deliveries: (id: string) => Promise<ScheduleDelivery[]>;
  setError: (msg: string | null) => void;
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  tasks: [],
  error: null,
  loading: false,
  saving: false,

  load: async () => {
    set({ loading: true });
    try {
      const data = await apiFetch<SchedulesPayload>("/api/schedules");
      set({ tasks: normalizeSchedules(data), error: null });
    } catch (e) {
      set({ error: errText(e) });
    } finally {
      set({ loading: false });
    }
  },

  save: async (draft) => {
    set({ saving: true });
    try {
      const body = JSON.stringify(draft);
      const saved = draft.id
        ? await apiFetch<ScheduleTask>("/api/schedules", { method: "PATCH", body })
        : await apiFetch<ScheduleTask>("/api/schedules", { method: "POST", body });
      await get().load();
      return saved;
    } catch (e) {
      set({ error: errText(e) });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  action: async (id, action) => {
    try {
      await apiFetch("/api/schedules/action", { method: "POST", body: JSON.stringify({ id, action }) });
      // 立即执行是后台投递，列表里的投递记录要过一会儿才有；先刷新一次拿状态。
      await get().load();
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  remove: async (id) => {
    try {
      await apiFetch(`/api/schedules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await get().load();
      return true;
    } catch (e) {
      set({ error: errText(e) });
      return false;
    }
  },

  deliveries: async (id) => {
    try {
      const data = await apiFetch<{ deliveries: ScheduleDelivery[] }>(
        `/api/schedules/deliveries?id=${encodeURIComponent(id)}`,
      );
      return Array.isArray(data?.deliveries) ? data.deliveries : [];
    } catch (e) {
      set({ error: errText(e) });
      return [];
    }
  },

  setError: (msg) => set({ error: msg }),
}));
