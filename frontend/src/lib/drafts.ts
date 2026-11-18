// 输入框草稿：按对话存在浏览器本地，重进前端（页面重载 / webview 被回收 /
// APP 被杀掉）之后还在。
//
// 为什么是浏览器而不是后端：草稿是「这台设备上的编辑状态」，和主题、侧栏排序一样
// 属于本机偏好，不进 settings.json——否则手机上没打完的半句会飘到 NAS 面板里。
//
// **只存正文**：附件是 File / blob，序列化不了；把 base64 塞进 localStorage 更不行
// （10MB 的图直接顶满配额，还会让别的草稿一起写失败）。待发送队列同理，仍然只在
// 内存里（见 lib/queue.ts）。

const STORAGE_KEY = "ccweb-drafts";

/** 单条草稿的字符上限：超过就不落盘（一条巨稿写失败会连累整张草稿表）。 */
export const MAX_DRAFT_CHARS = 100_000;
/** 最多保留多少条草稿（按最近编辑）。 */
export const MAX_DRAFT_ENTRIES = 20;
/** 草稿的保留时长：太久没动过的直接丢，不占着配额。 */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DraftEntry {
  text: string;
  /** 最后一次编辑时间（unix ms）：决定淘汰顺序。 */
  at: number;
}

type DraftMap = Record<string, DraftEntry>;

/**
 * draftKeyFor 返回草稿的键：有会话就用会话 id，否则按工作区分桶。
 *
 * 按会话分而不是全局一份：切回某条对话时应该看到那条对话自己的草稿，而不是
 * 上一条对话顺手打了一半的句子。还没有会话（空工作区 / 正在建）时按工作区分，
 * 别让两个目录共用同一份草稿。两者都没有就返回空串，表示不落盘。
 */
export function draftKeyFor(
  sessionId: string | null | undefined,
  workspace: string | null | undefined,
): string {
  if (sessionId) return sessionId;
  return workspace ? `ws:${workspace}` : "";
}

/** pruneDraftMap 丢掉空草稿、过期条目与超出上限的旧条目，返回新表（不改入参）。 */
export function pruneDraftMap(map: DraftMap | null | undefined, now: number = Date.now()): DraftMap {
  const rows: [string, DraftEntry][] = [];
  for (const [key, entry] of Object.entries(map ?? {})) {
    if (!key || !entry || typeof entry.text !== "string") continue;
    if (entry.text.trim() === "") continue;
    const at = Number.isFinite(entry.at) ? entry.at : 0;
    if (now - at > DRAFT_MAX_AGE_MS) continue;
    rows.push([key, { text: entry.text, at }]);
  }
  // 新的在前：超出上限时淘汰的必须是老草稿。
  rows.sort((a, b) => b[1].at - a[1].at);
  const out: DraftMap = {};
  for (const [key, entry] of rows.slice(0, MAX_DRAFT_ENTRIES)) out[key] = entry;
  return out;
}

function readMap(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return pruneDraftMap(parsed as DraftMap);
  } catch {
    // 隐私模式 / 手改坏了 JSON：当没有草稿，别拦着用户输入。
    return {};
  }
}

function writeMap(map: DraftMap): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 配额满 / 隐私模式：草稿只是便利功能，写失败绝不能影响发送。
  }
}

/** readDraft 读取某条对话的草稿；没有（或已过期）就是空串。 */
export function readDraft(key: string, now: number = Date.now()): string {
  if (!key) return "";
  const entry = readMap()[key];
  if (!entry) return "";
  return now - entry.at > DRAFT_MAX_AGE_MS ? "" : entry.text;
}

/** writeDraft 保存草稿。空正文（含纯空白）等于删掉这一条，别留下空壳。 */
export function writeDraft(key: string, text: string, now: number = Date.now()): void {
  if (!key) return;
  const map = readMap();
  if (text.trim() === "" || text.length > MAX_DRAFT_CHARS) {
    if (!(key in map)) return;
    delete map[key];
    writeMap(map);
    return;
  }
  map[key] = { text, at: now };
  writeMap(pruneDraftMap(map, now));
}

/** dropDraft 丢掉某条对话的草稿（删对话时用）。 */
export function dropDraft(key: string): void {
  if (!key) return;
  const map = readMap();
  if (!(key in map)) return;
  delete map[key];
  writeMap(map);
}

/**
 * moveDraft 把草稿从一个键搬到另一个键。
 *
 * 用在「新对话页的草稿 → 刚建好的会话 id」：那个新对话拿到 id 之后仍是同一条
 * 对话，输入框里的字不能因为换了键就消失。目标键已有草稿时不覆盖（宁可留着
 * 原来那份，也不要把用户后来打的字冲掉），只丢掉旧的。
 */
export function moveDraft(from: string, to: string, now: number = Date.now()): void {
  if (!from || !to || from === to) return;
  const map = readMap();
  const entry = map[from];
  if (!entry) return;
  delete map[from];
  if (!(to in map)) map[to] = { text: entry.text, at: now };
  writeMap(pruneDraftMap(map, now));
}
