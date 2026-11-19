import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

/**
 * prompt.echo：同一会话的别的设备发出的提示词。
 *
 * CLI 不带 `--replay-user-messages` 时不回显 stdin 里的消息，而用户气泡是发送方
 * 本地乐观插入的——不补这条，另一台设备上只会看到模型突然开始思考，用户刚发的
 * 那句话凭空消失。
 */
describe("prompt.echo", () => {
  beforeEach(() => {
    useAppStore.setState({ items: {}, settings: null });
  });

  it("把别的设备发的提示词补成用户气泡", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "prompt.echo",
      data: { text: "跑一遍测试", files: ["a.log"] },
    });
    const items = useAppStore.getState().items.s1;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "跑一遍测试\n附件：a.log" });
  });

  it("英文界面用「File: 」前缀（与发送方拼接的文案一致）", () => {
    useAppStore.setState({ settings: { locale: "en" } as never });
    useAppStore.getState().applyEvent("s1", { kind: "prompt.echo", data: { text: "run", files: ["a.log"] } });
    expect(useAppStore.getState().items.s1[0]).toMatchObject({ text: "run\nFile: a.log" });
  });

  it("图片按 data URL 需要的样子存进气泡", () => {
    useAppStore.getState().applyEvent("s1", {
      kind: "prompt.echo",
      data: { text: "", images: [{ name: "a.png", media_type: "image/png", data: "AAAA" }] },
    });
    expect(useAppStore.getState().items.s1[0]).toMatchObject({
      kind: "user",
      images: [{ name: "a.png", mediaType: "image/png", data: "AAAA" }],
    });
  });
});
