// 模型提问卡片（AskUserQuestion）的作答进度：按 request_id 存浏览器本地。
//
// 为什么要落盘：待审批卡片在 store 里是**会话级**的（`perms[sid]`），切走对话再切回来
// 组件会重新挂载、React state 归零；页面重载 / webview 被回收同样会丢。用户答到第 3 题
// 被打断，回来看到第 1 题空白——这比没有卡片更让人恼火。
//
// 与 lib/drafts.ts 同一套边界：只存纯文本（选项 label 与自定义回答），有界、能容忍坏
// JSON 与配额满（读不出来就当没有，绝不让卡片报错）。

import type { AskDraft } from "./askQuestion";

const STORAGE_KEY = "ccweb-ask-drafts";

/** 最多保留多少条（被提问打断的请求不会太多，超出的按最近编辑淘汰）。 */
export const MAX_ASK_DRAFTS = 10;
/** 保留时长：太老的提问早就被 CLI 结算掉了，草稿留着只会占配额。 */
export const ASK_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 一次提问的作答进度：当前第几题 + 每题的草稿。 */
export interface AskProgress {
  index: number;
  drafts: AskDraft[];
}

interface StoredProgress extends AskProgress {
  /** 最后一次编辑时间（unix ms），用于淘汰。 */
  at: number;
}

type ProgressMap = Record<string, StoredProgress>;

function readMap(): ProgressMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ProgressMap = {};
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const p = value as Partial<StoredProgress>;
      if (!Array.isArray(p.drafts)) continue;
      if (typeof p.index !== "number" || !Number.isFinite(p.index)) continue;
      if (typeof p.at !== "number" || now - p.at > ASK_DRAFT_MAX_AGE_MS) continue;
      const drafts: AskDraft[] = [];
      let bad = false;
      for (const item of p.drafts) {
        if (!item || typeof item !== "object") {
          bad = true;
          break;
        }
        const d = item as Partial<AskDraft>;
        if (!Array.isArray(d.selected) || typeof d.custom !== "string") {
          bad = true;
          break;
        }
        drafts.push({
          selected: d.selected.filter((x): x is string => typeof x === "string"),
          custom: d.custom,
          // 旧版本没有这个字段：按「未跳过」读，不能让升级后的草稿凭空变成「已跳过」。
          refused: d.refused === true,
        });
      }
      if (bad) continue;
      out[key] = { index: p.index, drafts, at: p.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: ProgressMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 配额满 / 隐私模式：草稿是便利功能，不能因为它让卡片崩掉。
  }
}

/**
 * 淘汰到上限（按 at 从新到旧保留最近 MAX_ASK_DRAFTS 条）。
 *
 * 同一毫秒里连存几条时 at 会相同：用写入顺序（对象键顺序）当第二个判据，
 * 否则留下哪几条取决于排序实现，刚写的反倒可能被淘汰。
 */
function pruneMap(map: ProgressMap): ProgressMap {
  const order = new Map(Object.keys(map).map((key, i) => [key, i]));
  const keys = Object.keys(map);
  if (keys.length <= MAX_ASK_DRAFTS) return map;
  const keep = keys
    .sort((a, b) => (map[b]?.at ?? 0) - (map[a]?.at ?? 0) || (order.get(b) ?? 0) - (order.get(a) ?? 0))
    .slice(0, MAX_ASK_DRAFTS);
  const out: ProgressMap = {};
  for (const key of keep) {
    const entry = map[key];
    if (entry) out[key] = entry;
  }
  return out;
}

/**
 * 读取一次提问的进度。
 *
 * `count` 是本次解析出的题目数量：与存下的不一致（模型重开了一轮提问、卡片结构变了）
 * 就丢弃——半份草稿套到另一批题上会给出错误的默认选中。
 */
export function loadAskProgress(requestId: string, count: number): AskProgress | null {
  if (!requestId || count <= 0) return null;
  const entry = readMap()[requestId];
  if (!entry || entry.drafts.length !== count) return null;
  const index = Math.min(Math.max(0, Math.trunc(entry.index)), count - 1);
  return {
    index,
    drafts: entry.drafts.map((d) => ({ selected: [...d.selected], custom: d.custom, refused: d.refused })),
  };
}

/**
 * 保存进度（每次改动都写：localStorage 同步写，几 KB 的 JSON 可以忽略）。
 *
 * 「没有任何作答、停在第 1 题」= 没有进度：**不落空草稿**。卡片一挂载就会调用这里，
 * 落的话每看一次提问就多一条空记录，把 10 条的配额挤掉真正有用的草稿。
 */
export function saveAskProgress(requestId: string, index: number, drafts: AskDraft[]): void {
  if (!requestId || drafts.length === 0) return;
  const untouched =
    index === 0 &&
    drafts.every((d) => d.selected.length === 0 && d.custom.trim() === "" && !d.refused);
  if (untouched) {
    const current = readMap();
    if (!(requestId in current)) return;
    delete current[requestId];
    writeMap(current);
    return;
  }
  const map = readMap();
  map[requestId] = {
    index,
    drafts: drafts.map((d) => ({ selected: [...d.selected], custom: d.custom, refused: d.refused === true })),
    at: Date.now(),
  };
  writeMap(pruneMap(map));
}

/** 这次提问已经有结论（提交 / 被别的设备答掉 / CLI 自己收尾）：清掉草稿。 */
export function clearAskProgress(requestId: string): void {
  if (!requestId) return;
  const map = readMap();
  if (!(requestId in map)) return;
  delete map[requestId];
  writeMap(map);
}
