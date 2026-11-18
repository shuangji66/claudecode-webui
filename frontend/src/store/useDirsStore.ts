// 「设置 → 目录」的数据层：飞牛已授权目录的列表与撤销。
//
// 只做三件事：查列表、撤销一个、把后端/飞牛给的原因原样留在 state 里。
// **添加不在这里**：授权必须由用户在选择器或授权页上确认（见 lib/fnos.ts 与回调页），
// 前端拿到结果后回来调 load() 刷新即可。
import { create } from "zustand";
import { apiFetch } from "../lib/runtime";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 与后端 gateway.dirsPayload 对应。 */
export interface DirsPayload {
  dirs: string[];
  uid?: number;
  /** 不能撤销的路径（应用自己的安装目录 / 数据目录）：界面不给撤销按钮。 */
  protected?: string[];
  /** 非空的 error 表示这次没查成（不在统一网关下 / 缺 token / scope 未声明）。 */
  error?: string;
}

interface DirsState {
  dirs: string[];
  /** 应用自己的目录：后端一律拒绝撤销，界面也不给按钮。 */
  protected: string[];
  uid: number | null;
  /** 查询失败的真正原因：要显示出来，不能当成「还没有授权目录」。 */
  error: string | null;
  loading: boolean;
  /** 正在撤销的路径（行内按钮置灰，避免重复点）。 */
  removing: string | null;

  load: () => Promise<void>;
  remove: (path: string) => Promise<boolean>;
  setError: (msg: string | null) => void;
}

export const useDirsStore = create<DirsState>((set) => ({
  dirs: [],
  protected: [],
  uid: null,
  error: null,
  loading: false,
  removing: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch<DirsPayload>("/api/dirs");
      set({
        // 后端保证是数组，但 localStorage / 旧版本兜底一次：undefined 会让页面崩在 .map。
        dirs: Array.isArray(res.dirs) ? res.dirs : [],
        protected: Array.isArray(res.protected) ? res.protected : [],
        uid: typeof res.uid === "number" ? res.uid : null,
        error: res.error ?? null,
        loading: false,
      });
    } catch (e) {
      set({ error: errText(e), loading: false });
    }
  },

  remove: async (path: string) => {
    set({ removing: path, error: null });
    try {
      const res = await apiFetch<DirsPayload>("/api/dirs/remove", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      set({
        dirs: Array.isArray(res.dirs) ? res.dirs : [],
        protected: Array.isArray(res.protected) ? res.protected : [],
        error: res.error ?? null,
        removing: null,
      });
      return true;
    } catch (e) {
      set({ error: errText(e), removing: null });
      return false;
    }
  },

  setError: (msg) => set({ error: msg }),
}));
