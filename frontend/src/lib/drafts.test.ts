import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_MAX_AGE_MS,
  MAX_DRAFT_CHARS,
  MAX_DRAFT_ENTRIES,
  draftKeyFor,
  dropDraft,
  moveDraft,
  pruneDraftMap,
  readDraft,
  writeDraft,
} from "./drafts";

beforeEach(() => {
  localStorage.clear();
});

describe("drafts 存取", () => {
  it("按对话各存一份，互不覆盖", () => {
    writeDraft("s1", "给 s1 打的字");
    writeDraft("s2", "给 s2 打的字");
    expect(readDraft("s1")).toBe("给 s1 打的字");
    expect(readDraft("s2")).toBe("给 s2 打的字");
    // 没有草稿的对话拿到空串（不是 undefined，组件直接当 value 用）
    expect(readDraft("s3")).toBe("");
  });

  it("空正文（含纯空白）等于删掉这一条", () => {
    writeDraft("s1", "abc");
    writeDraft("s1", "   \n\t ");
    expect(readDraft("s1")).toBe("");
    expect(localStorage.getItem("ccweb-drafts")).toBeNull();
  });

  it("重复编辑只留最后一次，且溢出时先淘汰最久没动的", () => {
    // at 必须是「现在」附近的时间：超过保留期会被当成过期草稿丢掉。
    const now = Date.now();
    writeDraft("s1", "一", now - 3000);
    writeDraft("s2", "二", now - 2000);
    writeDraft("s1", "一改", now - 1000);
    expect(readDraft("s1")).toBe("一改");

    for (let i = 0; i < MAX_DRAFT_ENTRIES - 1; i += 1) writeDraft(`x${i}`, `草稿 ${i}`, now + i);
    expect(readDraft("s2")).toBe(""); // 最久没动的那条被淘汰
    expect(readDraft("s1")).toBe("一改");
  });

  it("超长草稿不落盘（一条巨稿写失败会连累整张表）", () => {
    writeDraft("s1", "a".repeat(MAX_DRAFT_CHARS + 1));
    expect(readDraft("s1")).toBe("");
  });

  it("没有 key（既没有会话也没有工作区）时不写也不读", () => {
    writeDraft("", "不该存的字");
    expect(localStorage.getItem("ccweb-drafts")).toBeNull();
    expect(readDraft("")).toBe("");
  });

  it("storage 里是坏 JSON / 非对象时当没有草稿，不抛错", () => {
    localStorage.setItem("ccweb-drafts", "{不是 json");
    expect(readDraft("s1")).toBe("");
    localStorage.setItem("ccweb-drafts", "\"字符串\"");
    expect(readDraft("s1")).toBe("");
    // 坏数据不会让后续写入失效
    writeDraft("s1", "还能存");
    expect(readDraft("s1")).toBe("还能存");
  });
});

describe("drafts 过期与搬迁", () => {
  it("过期草稿既不读出也会在 prune 时丢掉", () => {
    const stale = Date.now() - DRAFT_MAX_AGE_MS - 1;
    writeDraft("old", "很久以前打的", stale);
    expect(readDraft("old")).toBe("");
    expect(pruneDraftMap({ old: { text: "很久以前打的", at: stale } })).toEqual({});
  });

  it("moveDraft 把新对话页的草稿迁到刚建好的会话 id 下", () => {
    writeDraft("ws:/work", "还没建会话时打的字");
    moveDraft("ws:/work", "uuid-1");
    expect(readDraft("uuid-1")).toBe("还没建会话时打的字");
    expect(readDraft("ws:/work")).toBe("");
  });

  it("moveDraft 不覆盖目标已有的草稿（宁可留新的那份）", () => {
    writeDraft("ws:/work", "旧的");
    writeDraft("uuid-1", "新的");
    moveDraft("ws:/work", "uuid-1");
    expect(readDraft("uuid-1")).toBe("新的");
    expect(readDraft("ws:/work")).toBe("");
  });

  it("dropDraft 只删这一条", () => {
    writeDraft("s1", "一");
    writeDraft("s2", "二");
    dropDraft("s1");
    expect(readDraft("s1")).toBe("");
    expect(readDraft("s2")).toBe("二");
  });
});

describe("draftKeyFor", () => {
  it("有会话用会话 id，没有会话按工作区分桶", () => {
    expect(draftKeyFor("uuid-1", "/work")).toBe("uuid-1");
    expect(draftKeyFor(null, "/work")).toBe("ws:/work");
    expect(draftKeyFor("", "/work")).toBe("ws:/work");
    expect(draftKeyFor(undefined, undefined)).toBe("");
  });
});
