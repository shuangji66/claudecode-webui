// 渲染异常的兜底层：任何组件抛错都不能让整页变成白屏。
//
// index.html 里那段兜底脚本只认「资源没加载 / 没挂载」，管不到「React 已经挂载、
// 某个组件渲染时抛错」——那种情况下 React 19 会卸载整棵树，用户看到的是一片空白，
// 控制台里的错误普通用户不会去看。这里把它变成一句人话 + 两个出口。
//
// 文案在函数组件里用 useT，class 组件拿不到 hook，所以由外层把字符串传进去。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { IconAlert, IconRetry } from "./Icons";

interface Labels {
  title: string;
  description: string;
  reload: string;
  reset: string;
  detail: string;
}

interface Props {
  children: ReactNode;
  labels: Labels;
}

interface State {
  error: Error | null;
}

class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 失败才记日志（约定：不输出例行日志）。
    console.error("[ui] 渲染异常", error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  /** 清掉本地界面缓存（令牌除外）再重载：多半是某份持久化状态把组件喂坏了。 */
  private reset = () => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("ccweb-") && key !== "ccweb-token") localStorage.removeItem(key);
      }
    } catch {
      // 隐私模式下 localStorage 不可用，直接重载即可
    }
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    const { labels, children } = this.props;
    if (!error) return children;
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-canvas p-6">
        <div className="w-full max-w-lg rounded-2xl border border-line bg-canvas p-5 shadow-soft">
          <div className="flex items-start gap-2.5">
            <IconAlert size={17} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0">
              <h1 className="text-[14px] font-semibold text-ink">{labels.title}</h1>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{labels.description}</p>
            </div>
          </div>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
            {labels.detail}: {error.message}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="inline-flex items-center gap-1.5 rounded-[9px] bg-brand px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-brand-hover"
            >
              <IconRetry size={14} />
              {labels.reload}
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-[9px] border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-panel-strong"
            >
              {labels.reset}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <Boundary
      labels={{
        title: t("界面出错了", "Something broke in the UI"),
        description: t(
          "这一屏渲染时抛了异常。可以先重新加载；如果还是这样，清掉本地设置再试。对话记录存在后端，不会因此丢失。",
          "A component threw while rendering this screen. Reload first; if it persists, clear local settings. Conversations live on the server and are not lost.",
        ),
        reload: t("重新加载", "Reload"),
        reset: t("清除本地设置并重载", "Clear local settings and reload"),
        detail: t("错误信息", "Error"),
      }}
    >
      {children}
    </Boundary>
  );
}
