// 内置终端的 WebSocket 客户端。
//
// 协议见 backend/internal/gateway/terminal_ws.go：
//   - 上行文本 JSON：input / resize / ping
//   - 下行文本 JSON：ready / exit / error / pong
//   - 下行二进制：PTY 原始字节（含 ANSI），由 TextDecoder 流式解码后喂给 xterm
//
// 组件只与这个类交互，不直接 new WebSocket。

import { terminalWsUrl } from "../lib/runtime";

export type TerminalPhase = "connecting" | "open" | "exited" | "closed" | "error" | "unsupported";

export interface TerminalStatusDetail {
  phase: TerminalPhase;
  /** 退出码，仅 exited 时有意义。 */
  code?: number;
  message?: string;
  shell?: string;
}

export interface TerminalHandlers {
  onOutput: (data: string) => void;
  onStatus: (detail: TerminalStatusDetail) => void;
}

/** 连续这么久没收到任何帧（含 pong）就判连接已死，走 onclose 重连/重启。 */
const TERMINAL_STALE_MS = 70_000;

export class TerminalConnection {
  private ws: WebSocket | null = null;
  private decoder = new TextDecoder();
  private closedByUs = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  /** 最后一次已上报的状态；服务端先发 error/exit 再关连接时不能被 closed 覆盖。 */
  private lastPhase: TerminalPhase = "connecting";

  constructor(
    private readonly cwd: string,
    private readonly cols: number,
    private readonly rows: number,
    private readonly token: string,
    private readonly handlers: TerminalHandlers,
  ) {}

  private emit(detail: TerminalStatusDetail): void {
    this.lastPhase = detail.phase;
    this.handlers.onStatus(detail);
  }

  connect(): void {
    this.closedByUs = false;
    this.emit({ phase: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(terminalWsUrl(this.cwd, this.cols, this.rows, this.token));
    } catch (reason) {
      this.emit({ phase: "error", message: reason instanceof Error ? reason.message : String(reason) });
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.lastMessageAt = Date.now();
      this.emit({ phase: "open" });
      this.startPing();
      this.resize(this.cols, this.rows);
    };
    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      if (typeof event.data === "string") {
        this.handleControl(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.handlers.onOutput(this.decoder.decode(new Uint8Array(event.data), { stream: true }));
      }
    };
    ws.onerror = () => {
      // onclose 会带更具体的信息；这里不重复上报。
    };
    ws.onclose = () => {
      this.stopPing();
      // 刷掉被切断的最后一个多字节字符，避免尾部乱码/丢字。
      const tail = this.decoder.decode();
      if (tail) this.handlers.onOutput(tail);
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs) return;
      // error / exited 已经带上了真正的原因，close 只是它的尾巴。
      if (this.lastPhase === "error" || this.lastPhase === "exited") return;
      this.emit({ phase: "closed" });
    };
  }

  private handleControl(raw: string): void {
    let msg: { type?: string; code?: number; message?: string; shell?: string };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        this.emit({ phase: "open", shell: msg.shell });
        break;
      case "exit":
        this.emit({ phase: "exited", code: msg.code ?? 0 });
        break;
      case "error":
        this.emit({ phase: "error", message: msg.message ?? "终端错误" });
        break;
      case "pong":
        break;
      default:
        break;
    }
  }

  private startPing(): void {
    this.stopPing();
    // 空闲终端没有输出，靠 ping 让中间层/浏览器保持连接活跃。
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // 只发 ping 不判活的话，半开连接（NAT 超时、手机丢网）不会触发 onclose：
      // 界面一直显示「已连接」，而 PTY 输出与输入两边都静默失效。
      if (Date.now() - this.lastMessageAt > TERMINAL_STALE_MS) {
        this.ws.close(4000, "heartbeat timeout");
        return;
      }
      this.ws.send(JSON.stringify({ type: "ping" }));
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendInput(data: string): void {
    if (!data || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "input", data }));
  }

  resize(cols: number, rows: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, "client closed");
      } catch {
        /* 浏览器可能已经在关闭流程里 */
      }
    }
  }
}
