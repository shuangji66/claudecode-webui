// WebSocket 传输层：与 Go 后端的一个会话端点对接。
//
// 上行是 ClientCommand（JSON），下行是 WireEvent。
//
// 断线自动重连（对齐 DSH 的体验）：指数退避 + 心跳探活 + 浏览器 online /
// 页面重新可见时立即重试。关闭由调用方发起（close()）时不再重连。

import { wsUrl } from "../lib/runtime";
import type { ClientCommand, WireEvent } from "./types";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface StatusDetail {
  /** 第几次重连尝试（从 1 开始）。 */
  attempt?: number;
  /** 下一次重试的等待时间，供界面显示。 */
  delayMs?: number;
  /** 断开原因，仅用于提示。 */
  reason?: string;
}

export interface ClientHandlers {
  onEvent: (ev: WireEvent) => void;
  onStatus?: (status: ConnStatus, detail?: StatusDetail) => void;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_STALE_MS = 55_000;

/** 指数退避：0.4s 起，最多 5s；加一点抖动避免多标签页同时重连。 */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(5_000, 400 * 2 ** Math.min(Math.max(attempt, 1) - 1, 4));
  return base + Math.floor(Math.random() * 250);
}

export class ClaudeClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private listenersBound = false;

  constructor(
    private readonly sessionId: string,
    private readonly token: string,
    private readonly handlers: ClientHandlers,
  ) {}

  connect(): void {
    if (this.ws) return;
    this.closedByUs = false;
    this.bindBrowserEvents();
    this.openSocket();
  }

  private openSocket(): void {
    this.clearRetry();
    if (this.closedByUs) return;

    this.handlers.onStatus?.(this.attempts > 0 ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(this.sessionId, this.token));
    } catch {
      this.scheduleRetry("无法创建 WebSocket");
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.handlers.onStatus?.("open");
      this.startHeartbeat();
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      this.lastMessageAt = Date.now();
      let parsed: WireEvent;
      try {
        parsed = JSON.parse(e.data) as WireEvent;
      } catch {
        return;
      }
      // 心跳回包只用于探活，不进入业务渲染。
      if (parsed.kind === "pong") return;
      this.handlers.onEvent(parsed);
    };

    ws.onclose = (e) => {
      this.stopHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs) return;
      this.scheduleRetry(`连接已断开（${e.code}）`);
    };

    ws.onerror = () => {
      // 具体原因由 onclose 统一处理，这里不重复上报。
    };
  }

  private scheduleRetry(reason: string): void {
    if (this.closedByUs || this.retryTimer) return;
    this.attempts += 1;
    const delayMs = reconnectDelay(this.attempts);
    this.handlers.onStatus?.("reconnecting", { attempt: this.attempts, delayMs, reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > HEARTBEAT_STALE_MS) {
        // 半开连接不会触发 onclose；主动关掉，让 onclose 走重连。
        try {
          this.ws.close(4000, "heartbeat timeout");
        } catch {
          /* 忽略：下一轮重连会兜底 */
        }
        return;
      }
      this.send({ kind: "ping" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 立即重试（页面重新可见 / 网络恢复 / 用户点「重试」）。 */
  retryNow(): void {
    if (this.closedByUs) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.clearRetry();
    this.openSocket();
  }

  private bindBrowserEvents(): void {
    if (this.listenersBound || typeof window === "undefined") return;
    this.listenersBound = true;
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private unbindBrowserEvents(): void {
    if (!this.listenersBound || typeof window === "undefined") return;
    this.listenersBound = false;
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onOnline = (): void => {
    this.retryNow();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.retryNow();
  };

  send(cmd: ClientCommand): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  }

  close(): void {
    this.closedByUs = true;
    this.clearRetry();
    this.stopHeartbeat();
    this.unbindBrowserEvents();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "client close");
      } catch {
        /* 忽略：连接可能已经结束 */
      }
    }
    this.handlers.onStatus?.("closed");
  }

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get status(): ConnStatus {
    if (this.closedByUs) return "closed";
    if (this.ws?.readyState === WebSocket.OPEN) return "open";
    if (this.ws?.readyState === WebSocket.CONNECTING) return this.attempts > 0 ? "reconnecting" : "connecting";
    return this.attempts > 0 ? "reconnecting" : "connecting";
  }
}
