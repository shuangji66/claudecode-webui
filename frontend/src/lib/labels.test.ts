import { describe, expect, it } from "vitest";
import {
  baseName,
  conversationStatusLabel,
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

  it("conversationStatusLabel 覆盖五种会话状态", () => {
    expect(conversationStatusLabel("approval")).toBe("待审批");
    expect(conversationStatusLabel("ongoing")).toBe("运行中");
    expect(conversationStatusLabel("done")).toBe("已完成");
    expect(conversationStatusLabel("active")).toBe("空闲");
    expect(conversationStatusLabel("off")).toBe("未运行");
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

  it("CLI 自带的 skill 也有中文说明", () => {
    const en = "Skill — Review the changed code for cleanup opportunities and apply the fixes.";
    expect(commandDescription("simplify", en, "zh")).toBe("精简改动过的代码");
    expect(commandDescription("fewer-permission-prompts", en, "zh")).toBe("生成权限白名单，少弹审批");
    expect(commandDescription("verify", en, "zh")).toBe("跑起来确认改动生效");
  });

  it("2.1.329 里出现、以前漏收录的命令都有中文", () => {
    // 清单取自 `claude` 二进制里 `{type:"local",name:"…"}` 的定义（2.1.329 共 99 条），
    // 这里抽查几条曾经的漏网之鱼：`/` 菜单列全量之后它们都会露出来。
    expect(commandDescription("update-config", "Use this skill to configure…", "zh")).toBe(
      "修改设置：钩子、权限、环境变量",
    );
    expect(commandDescription("commit", "Create a git commit", "zh")).toBe("提交当前改动");
    expect(commandDescription("theme", "Change the theme", "zh")).toBe("切换主题");
    expect(commandDescription("remote-control", "Control this session…", "zh")).toBe("从手机或网页控制本会话");
    expect(commandDescription("tui", "Set the terminal UI renderer", "zh")).toBe("选择终端界面渲染方式");
  });

  it("没收录的命令回落 CLI 描述；英文环境直接用原文", () => {
    // 用户自己写的 skill / MCP 命令不可能有中文，只能回落原文。
    expect(commandDescription("my-own-skill", "Does my thing", "zh")).toBe("Does my thing");
    expect(commandDescription("my-own-skill", undefined, "zh")).toBe("");
    expect(commandDescription("compact", "Compact the conversation", "en")).toBe("Compact the conversation");
    expect(commandDescription("simplify", "Skill — tidy up", "en")).toBe("Skill — tidy up");
  });
});
