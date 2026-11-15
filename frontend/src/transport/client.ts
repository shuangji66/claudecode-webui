// WebSocket 传输层：与 Go 后端的一个会话端点对接。
//
// 上行是 ClientCommand（JSON），下行是 WireEvent。

import { wsUrl } from "../lib/runtime";
import type { ClientCommand, WireEvent } from "./types";

export interface ClientHandlers {
  onEvent: (ev: WireEvent) => void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
}

export class ClaudeClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(
    private readonly sessionId: string,
    private readonly token: string,
    private readonly handlers: ClientHandlers,
  ) {}

  connect(): void {
    const ws = new WebSocket(wsUrl(this.sessionId, this.token));
    this.ws = ws;

    ws.onopen = () => this.handlers.onOpen?.();

    ws.onmessage = (e: MessageEvent<string>) => {
      let parsed: WireEvent;
      try {
        parsed = JSON.parse(e.data) as WireEvent;
      } catch {
        return;
      }
      this.handlers.onEvent(parsed);
    };

    ws.onclose = (e) => {
      if (this.closedByUs) return;
      this.handlers.onClose?.(`连接已断开（${e.code}）`);
    };

    ws.onerror = () => {
      // 具体原因由 onclose 统一处理，这里不重复上报。
    };
  }

  send(cmd: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
