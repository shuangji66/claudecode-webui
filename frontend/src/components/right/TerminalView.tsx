import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useT } from "../../lib/i18n";
import { getToken } from "../../lib/runtime";
import { TerminalConnection, type TerminalPhase } from "../../transport/terminal";
import { IconRetry } from "../common/Icons";

interface Props {
  cwd: string;
  /** 标签是否可见。隐藏时只停 fit，不结束 shell。 */
  active: boolean;
}

const FONT_SIZE = 12.5;
const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
/** xterm 配色：从当前主题令牌读取，切主题时由 MutationObserver 重新应用。 */
function currentTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const background = read("--c-canvas", "#ffffff");
  const foreground = read("--c-ink", "#1a1a1a");
  const muted = read("--c-muted", "#6b7280");
  const brand = read("--c-brand", "#d97757");
  return {
    background,
    foreground,
    cursor: brand,
    cursorAccent: background,
    selectionBackground: "rgba(217, 119, 87, 0.28)",
    black: foreground,
    red: "#e5484d",
    green: "#30a46c",
    yellow: "#d97706",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#0891b2",
    white: foreground,
    brightBlack: muted,
    brightRed: "#f87171",
    brightGreen: "#34d399",
    brightYellow: "#fbbf24",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#22d3ee",
    brightWhite: foreground,
  };
}

/**
 * 单个终端视图：一条 WS、一个 PTY。
 *
 * 多开由右侧栏的标签负责——每个终端就是顶部一个独立标签，切标签只是隐藏，
 * 不结束进程；关掉标签才真正关闭这个 shell。
 */
export default function TerminalView({ cwd, active }: Props) {
  return <TerminalSession cwd={cwd} active={active} />;
}

function TerminalSession({ cwd, active }: { cwd: string; active: boolean }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<TerminalPhase>("connecting");
  const [message, setMessage] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [shell, setShell] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "block",
      fontSize: FONT_SIZE,
      fontFamily: FONT_FAMILY,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      convertEol: false,
      allowTransparency: false,
      theme: currentTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let disposed = false;
    let resizeTimer = 0;
    const applyFit = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // 容器隐藏时尺寸为 0，忽略即可；重新可见会再触发。
      }
    };
    const raf = requestAnimationFrame(() => {
      applyFit();
      term.focus();
    });

    const connection = new TerminalConnection(cwd, term.cols || 80, term.rows || 24, getToken(), {
      // 卸载/重连后 WebSocket 仍可能派发已在队列里的帧（含 onclose 里刷出的
      // decoder 尾巴），而 term 已经 dispose 过了。往已释放的实例写是未定义行为。
      onOutput: (data) => {
        if (disposed) return;
        term.write(data);
      },
      onStatus: (detail) => {
        if (disposed) return;
        setPhase(detail.phase);
        setMessage(detail.message ?? "");
        setExitCode(detail.code ?? null);
        if (detail.shell) setShell(detail.shell);
        // 首次 fit 可能发生在 WS 打开之前，那次 resize 会被丢掉；连上后补一次。
        if (detail.phase === "open") connection.resize(term.cols, term.rows);
      },
    });
    connection.connect();

    const inputSub = term.onData((data) => connection.sendInput(data));
    const resizeSub = term.onResize(({ cols, rows }) => connection.resize(cols, rows));

    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(applyFit, 120);
    });
    observer.observe(host);

    // 主题切换后 xterm 不会自动重读 CSS 变量。
    const themeObserver = new MutationObserver(() => {
      term.options.theme = currentTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    fitRef.current = applyFit;

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      themeObserver.disconnect();
      inputSub.dispose();
      resizeSub.dispose();
      fitRef.current = null;
      connection.close();
      term.dispose();
    };
  }, [cwd, run]);

  // 从别的标签 / 别的面板切回来时容器尺寸可能变了；补一次 fit。
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const restart = () => {
    setPhase("connecting");
    setMessage("");
    setExitCode(null);
    setRun((n) => n + 1);
  };

  const dead = phase === "exited" || phase === "closed" || phase === "error";
  const statusText =
    phase === "open"
      ? t("已连接", "Connected")
      : phase === "connecting"
        ? t("连接中…", "Connecting…")
        : phase === "exited"
          ? t(`进程已退出${exitCode !== null ? `（${exitCode}）` : ""}`, `Exited${exitCode !== null ? ` (${exitCode})` : ""}`)
          : phase === "closed"
            ? t("连接已断开", "Disconnected")
            : phase === "unsupported"
              ? t("当前平台不支持终端", "Terminal unsupported")
              : t("终端错误", "Terminal error");
  const dot = phase === "open" ? "bg-ok" : phase === "connecting" ? "bg-warn" : "bg-danger";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1 bg-canvas">
        <div ref={hostRef} className="ccweb-term absolute inset-0 overflow-hidden" />
        {dead && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 px-5 backdrop-blur-[1px]">
            <div className="w-full max-w-[300px] rounded-xl border border-line bg-canvas p-3 text-center shadow-soft">
              <p className="text-[12px] font-medium text-ink">{statusText}</p>
              {message && <p className="mt-1 break-words text-[10.5px] leading-relaxed text-muted">{message}</p>}
              <button
                type="button"
                onClick={restart}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[11.5px] font-medium text-canvas hover:opacity-90"
              >
                <IconRetry size={13} />
                {t("重启该终端", "Restart this terminal")}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-line px-2 py-1 text-[9.5px] text-faint">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          <span className="shrink-0">{statusText}</span>
          {shell && <span className="min-w-0 truncate font-mono" title={shell}>{shell.split("/").pop()}</span>}
          <span className="ml-auto shrink-0 font-mono" title={cwd}>
            {cwd.split("/").pop() || cwd}
          </span>
          <button
            type="button"
            onClick={restart}
            className="shrink-0 rounded p-1 hover:bg-black/5 hover:text-ink"
            aria-label={t("重启终端", "Restart terminal")}
            title={t("重启终端", "Restart terminal")}
          >
            <IconRetry size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
