// 「设置 → MCP → 内置浏览器」：运行时（playwright 包 + 两个内核）的下载与状态。
//
// 它和下面那些 MCP server 不是一回事：这里管的是本应用自带的 `ccweb mcp-browser`
// 子命令要用的浏览器运行时。工具本身由后端随启动注册成用户级服务（ccweb-browser），
// 这一页只回答「装没装、装的是哪一版、正在下多少」。
//
// 为什么由我们托管下载：项目只部署一个 ccweb 二进制，用户机器上没有稳定的 playwright；
// 而「跑的是哪个浏览器版本」必须能在这里说出来（排查页面差异时第一个要问的就是它）。
import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useBrowserStore } from "../../store/useBrowserStore";
import { askConfirm } from "../common/SystemDialogs";
import { Button } from "../common/Button";
import { Collapsible } from "../common/Collapsible";
import { IconAlert, IconCheck, IconDownload, IconMonitor, IconTrash } from "../common/Icons";

/** 安装阶段的文案（后端给字符串，前端映射；认不出的原样显示）。 */
function phaseLabel(phase: string, t: (zh: string, en: string) => string): string {
  switch (phase) {
    case "downloading":
      return t("正在下载", "Downloading");
    case "extracting":
      return t("正在解包", "Extracting");
    case "installing":
      return t("正在安装内核", "Installing browsers");
    case "error":
      return t("安装失败", "Failed");
    case "cancelled":
      return t("已取消", "Cancelled");
    case "done":
      return t("已就绪", "Ready");
    default:
      return "";
  }
}

export function BrowserSettings() {
  const t = useT();
  const status = useBrowserStore((s) => s.status);
  const error = useBrowserStore((s) => s.error);
  const busy = useBrowserStore((s) => s.busy);
  const load = useBrowserStore((s) => s.load);
  const install = useBrowserStore((s) => s.install);
  const cancel = useBrowserStore((s) => s.cancel);
  const remove = useBrowserStore((s) => s.remove);

  useEffect(() => {
    void load();
  }, [load]);

  // 安装是后台任务：进行中才轮询，装完自然停下（对齐 claude 版本下载那一页）。
  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const installed = status?.installed ?? false;
  const kernels = status?.kernels ?? [];
  const missing = kernels.filter((k) => !k.installed).length;
  const percent =
    status && status.total > 0 ? Math.max(0, Math.min(100, Math.round((status.progress / status.total) * 100))) : 0;

  const summary = !status
    ? ""
    : running
      ? phaseLabel(status.phase, t)
      : installed
        ? t("已就绪", "Ready")
        : status.node_path
          ? t("未安装", "Not installed")
          : t("缺少 node", "node missing");

  const confirmRemove = async () => {
    const ok = await askConfirm({
      title: t("删除浏览器运行时？", "Remove browser runtime?"),
      message: t(
        `会删掉已下载的 Playwright ${status?.playwright ?? ""} 与 ${kernels.length} 个内核（约 285MB）。\n\n已经打开浏览器的会话会失效，重开对话后需要重新安装。`,
        `This deletes Playwright ${status?.playwright ?? ""} and ${kernels.length} browser build(s) (~285MB).\n\nSessions with an open browser will break until you reinstall.`,
      ),
      confirmText: t("删除", "Remove"),
      danger: true,
    });
    if (ok) await remove();
  };

  return (
    <div className="mb-5">
      <Collapsible
        title={t("内置浏览器（Playwright）", "Built-in browser (Playwright)")}
        icon={<IconMonitor size={13} />}
        summary={summary}
        tone="muted"
        actions={
          running ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void cancel()}>
              {t("取消", "Cancel")}
            </Button>
          ) : installed ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void install()} icon={<IconDownload size={12} />}>
              {t("重新安装", "Reinstall")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !status?.node_path}
              onClick={() => void install()}
              icon={<IconDownload size={12} />}
            >
              {t("安装", "Install")}
            </Button>
          )
        }
      >
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          {t(
            "让模型用真实浏览器打开页面：JS 渲染、登录态、点击翻页、截图确认布局。运行时与内核都装在本应用的数据目录里（不进系统），版本固定。模型在给出最终答复前应调用 browser_close，忘了也会在空闲后自动回收。",
            "Lets the model drive a real browser: JS-rendered pages, login state, clicking, screenshots. The runtime and browser live under this app's data directory with pinned versions. The model closes the browser before its final answer; idle browsers are also reaped.",
          )}
        </p>

        {error && (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-danger dark:border-rose-900/60 dark:bg-rose-950/30">
            <IconAlert size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {status && !status.node_path && (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-warn dark:border-amber-900/60 dark:bg-amber-950/30">
            <IconAlert size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              {t(
                "找不到 node：内置浏览器需要 node 运行时（本应用安装时依赖 nodejs_v24）。装回 node 之后刷这一页。",
                "node not found: the built-in browser needs a node runtime (this app depends on nodejs_v24). Install it and reload this page.",
              )}
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          {kernels.map((k) => (
            <div
              key={k.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-panel/40 px-2.5 py-1.5"
            >
              <span className="text-[12px] font-medium text-ink">{k.label}</span>
              <span className="font-mono text-[11px] text-muted">{k.version}</span>
              <span className="font-mono text-[10px] text-faint">build {k.build}</span>
              <span className="ml-auto flex items-center gap-1 text-[11px]">
                {!k.installed ? (
                  <span className="text-faint">{t("未安装", "Not installed")}</span>
                ) : status?.testing && k.available ? (
                  // 自检还没出结论：这时说「可用」是把「没测」当成「没问题」。
                  <span className="text-faint">{t("检测中…", "Checking…")}</span>
                ) : k.available ? (
                  <>
                    <IconCheck size={12} className="text-brand" />
                    <span className="text-muted">{t("可用", "Available")}</span>
                  </>
                ) : (
                  <>
                    <IconAlert size={12} className="text-danger" />
                    <span className="text-danger">{t("起不来", "Cannot start")}</span>
                  </>
                )}
              </span>
              {k.installed && k.available === false && k.problem && (
                <div className="w-full break-words text-[10.5px] leading-relaxed text-faint">{k.problem}</div>
              )}
            </div>
          ))}
        </div>

        {running && (
          <div className="mt-2">
            <div className="h-1 w-full overflow-hidden rounded-full bg-panel-strong">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-300"
                style={{ width: status?.total ? `${percent}%` : "35%" }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-muted">
              <span className="min-w-0 truncate" title={status?.note}>
                {status?.note || phaseLabel(status?.phase ?? "", t)}
              </span>
              {status?.total ? <span className="shrink-0 font-mono">{percent}%</span> : null}
            </div>
          </div>
        )}

        {!running && status?.phase === "error" && status.error && (
          <div className="mt-2 text-[11px] leading-relaxed text-danger">{status.error}</div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {installed && !running && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void confirmRemove()} icon={<IconTrash size={12} />}>
              {t("删除运行时", "Remove runtime")}
            </Button>
          )}
          {installed && missing > 0 && (
            <span className="text-[10.5px] text-faint">
              {t(`还有 ${missing} 个内核没装完`, `${missing} browser build(s) missing`)}
            </span>
          )}
        </div>

        {status && (
          <div className="mt-2 space-y-0.5 font-mono text-[10px] text-faint">
            <div className="truncate" title={status.root}>
              {status.root}
            </div>
            <div className="truncate">
              playwright {status.playwright}
              {status.node_version ? ` · node ${status.node_version}` : ""}
            </div>
          </div>
        )}
      </Collapsible>
    </div>
  );
}
