import { describe, expect, it } from "vitest";
import {
  baseName,
  conversationTitle,
  permissionLabel,
  relativeTime,
  sessionTitle,
  stateLabel,
  commandDescription,
} from "./labels";
import type { Item } from "./model";

describe("labels", () => {
  it("baseName 取路径末段", () => {
    expect(baseName("/a/b/c")).toBe("c");
    expect(baseName("/")).toBe("/");
  });

  it("sessionTitle 用第一条用户消息", () => {
    const items: Item[] = [
      { id: "1", seq: 0, ts: 0, kind: "assistant", text: "hi", streaming: false },
      { id: "2", seq: 1, ts: 0, kind: "user", text: "  帮我修一下构建  " },
    ];
    expect(sessionTitle("/data/proj", items)).toBe("帮我修一下构建");
  });

  it("sessionTitle 没有消息时用目录名", () => {
    expect(sessionTitle("/data/proj", [])).toBe("proj");
  });

  it("conversationTitle 优先自定义标题，其次首条消息，最后新对话", () => {
    expect(conversationTitle("自定义", [])).toBe("自定义");
    expect(conversationTitle("", [{ id: "1", seq: 0, ts: 0, kind: "user", text: "问题" }])).toBe("问题");
    expect(conversationTitle("", [])).toBe("新对话");
  });

  it("relativeTime 覆盖分钟/小时/天", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2026-01-01T23:59:30Z", now)).toBe("刚刚");
    expect(relativeTime("2026-01-01T23:30:00Z", now)).toBe("30 分钟前");
    expect(relativeTime("2026-01-01T21:00:00Z", now)).toBe("3 小时前");
    expect(relativeTime("2025-12-31T00:00:00Z", now)).toBe("2 天前");
  });

  it("permissionLabel 映射已知模式", () => {
    // 空值 = 没显式指定，显示成默认模式（曾经是单独的「标准模式」，和默认模式重复）。
    expect(permissionLabel("")).toBe("默认模式");
    expect(permissionLabel(undefined)).toBe("默认模式");
    expect(permissionLabel("")).toBe(permissionLabel("default"));
    expect(permissionLabel("acceptEdits")).toBe("接受编辑");
    expect(permissionLabel("custom")).toBe("custom");
  });
});

describe("labels (en)", () => {
  it("英文模式下时间与权限标签", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2026-01-01T23:30:00Z", now, "en")).toBe("30 min ago");
    expect(permissionLabel("acceptEdits", "en")).toBe("Accept edits");
    expect(stateLabel("busy", "en")).toBe("Running");
    expect(sessionTitle("/data/proj", [], "en")).toBe("proj");
  });
});

describe("commandDescription", () => {
  it("常用命令给中文短说明", () => {
    expect(commandDescription("compact", "Compact the conversation", "zh")).toBe("压缩对话上下文");
    expect(commandDescription("model", undefined, "zh")).toBe("切换本会话模型");
  });

  it("没收录的命令回落 CLI 描述；英文环境直接用原文", () => {
    expect(commandDescription("deep-research", "Deep research harness", "zh")).toBe("Deep research harness");
    expect(commandDescription("compact", "Compact the conversation", "en")).toBe("Compact the conversation");
  });
});
