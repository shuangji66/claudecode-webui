import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR,
  busyEnter,
  otherBusyEnter,
  parseBusyEnter,
  resetBusyEnterCache,
  resolveBusySubmit,
  setBusyEnter,
  subscribeBusyEnter,
} from "./busyEnter";

describe("parseBusyEnter", () => {
  it("只认两档，其余一律回落到默认（排队）", () => {
    expect(parseBusyEnter("queue")).toBe("queue");
    expect(parseBusyEnter("steer")).toBe("steer");
    expect(parseBusyEnter("")).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR);
    expect(parseBusyEnter(null)).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR);
    expect(parseBusyEnter("send")).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR);
  });
});

describe("繁忙时的发送行为偏好", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBusyEnterCache();
  });

  it("默认排队：与加入这条偏好之前的行为一致", () => {
    expect(DEFAULT_BUSY_ENTER_BEHAVIOR).toBe("queue");
    expect(busyEnter()).toBe("queue");
  });

  it("写入后落库，重新读缓存也是新值", () => {
    setBusyEnter("steer");
    expect(localStorage.getItem("ccweb-busy-enter")).toBe("steer");
    resetBusyEnterCache();
    expect(busyEnter()).toBe("steer");
  });

  it("订阅者会被通知", () => {
    let calls = 0;
    const off = subscribeBusyEnter(() => {
      calls += 1;
    });
    setBusyEnter("steer");
    expect(calls).toBe(1);
    off();
    setBusyEnter("queue");
    expect(calls).toBe(1);
  });

  it("盘上是不认识的值时当没设置过", () => {
    localStorage.setItem("ccweb-busy-enter", "priority");
    resetBusyEnterCache();
    expect(busyEnter()).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR);
  });
});

describe("otherBusyEnter", () => {
  it("两档互为另一档", () => {
    expect(otherBusyEnter("queue")).toBe("steer");
    expect(otherBusyEnter("steer")).toBe("queue");
  });
});

// 这一组钉的是「什么时候排队、什么时候写 stdin」：主手势走偏好，Ctrl/⌘+Enter 走另一档。
describe("resolveBusySubmit", () => {
  it("不忙：直接发（首条消息没有本轮可并入）", () => {
    expect(resolveBusySubmit("queue", { busy: false, accelerated: false, queued: 0 })).toBe("send");
    expect(resolveBusySubmit("steer", { busy: false, accelerated: false, queued: 0 })).toBe("send");
  });

  it("不忙但队列里压着消息：排队尾，不插到前面那条之前", () => {
    expect(resolveBusySubmit("queue", { busy: false, accelerated: false, queued: 1 })).toBe("queue");
    expect(resolveBusySubmit("steer", { busy: false, accelerated: false, queued: 1 })).toBe("queue");
  });

  it("偏好排队：Enter 入队，Ctrl/⌘+Enter 立刻插话", () => {
    expect(resolveBusySubmit("queue", { busy: true, accelerated: false, queued: 0 })).toBe("queue");
    expect(resolveBusySubmit("queue", { busy: true, accelerated: true, queued: 0 })).toBe("steer");
  });

  it("偏好插话：Enter 立刻插话，Ctrl/⌘+Enter 改为排队", () => {
    expect(resolveBusySubmit("steer", { busy: true, accelerated: false, queued: 0 })).toBe("steer");
    expect(resolveBusySubmit("steer", { busy: true, accelerated: true, queued: 0 })).toBe("queue");
  });
});
