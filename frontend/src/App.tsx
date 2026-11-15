import { useEffect, useState } from "react";
import { useAppStore } from "./store/useAppStore";
import { getToken } from "./lib/runtime";
import { applyPreferences, watchSystemTheme } from "./lib/theme";
import { I18nProvider, useT } from "./lib/i18n";
import { Sidebar } from "./components/layout/Sidebar";
import { ChatPane } from "./components/chat/ChatPane";
import { SettingsDrawer } from "./components/layout/SettingsDrawer";
import { TokenGate } from "./components/layout/TokenGate";
import { WorkspaceDialog } from "./components/layout/WorkspaceDialog";
import { HistoryDialog } from "./components/layout/HistoryDialog";
import { BrandMark, IconClose, IconRetry } from "./components/common/Icons";

const COLLAPSE_KEY = "ccweb-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const settings = useAppStore((s) => s.settings);
  const locale = settings?.locale === "en" ? "en" : "zh";

  useEffect(() => {
    applyPreferences(settings);
    return watchSystemTheme(settings, () => applyPreferences(settings));
  }, [settings]);

  return (
    <I18nProvider locale={locale}>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const t = useT();
  const info = useAppStore((s) => s.info);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const clearError = useAppStore((s) => s.clearError);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap, tokenEpoch]);

  const toggleCollapse = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* 忽略隐私模式 */
      }
      return next;
    });
  };

  // /api/info 需要鉴权：没有令牌时 bootstrap 会拿到 unauthorized。
  // 这时必须进入令牌门，而不是显示「无法连接服务」。
  if (!info && !loading && !getToken() && (error ?? "").toLowerCase().includes("unauthorized")) {
    return <TokenGate onSaved={() => setTokenEpoch((n) => n + 1)} />;
  }

  if (!info) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
        <BrandMark size={40} className="text-ink" />
        <div>
          <p className="text-[15px] font-medium text-ink">{loading ? t("正在连接服务…", "Connecting…") : t("无法连接服务", "Cannot connect")}</p>
          <p className="mt-1 max-w-md break-words text-[12px] leading-relaxed text-muted">{error ?? t("正在加载配置与会话列表", "Loading settings and sessions")}</p>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void bootstrap()}
            className="flex items-center gap-1.5 rounded-full border border-line-strong px-4 py-2 text-[12px] font-medium text-ink hover:bg-panel-strong"
          >
            <IconRetry size={14} />
            {t("重试", "Retry")}
          </button>
        )}
      </div>
    );
  }

  // 后端要求鉴权但本地没有令牌：先拦一道。
  if (info.auth_required && !getToken()) {
    return <TokenGate onSaved={() => setTokenEpoch((n) => n + 1)} />;
  }

  const openSettings = () => {
    setSidebarOpen(false);
    setSettingsOpen(true);
  };
  const openWorkspace = () => {
    setSidebarOpen(false);
    setWorkspaceOpen(true);
  };
  const openHistory = () => {
    setSidebarOpen(false);
    setHistoryOpen(true);
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-canvas">
      <div className="hidden md:flex">
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          onOpenSettings={openSettings}
          onAddWorkspace={openWorkspace}
          onOpenHistory={openHistory}
        />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="h-full w-[86vw] max-w-[330px] shadow-2xl">
            <Sidebar
              onClose={() => setSidebarOpen(false)}
              onOpenSettings={openSettings}
              onAddWorkspace={openWorkspace}
              onOpenHistory={openHistory}
            />
          </div>
          <button
            type="button"
            aria-label={t("关闭侧栏", "Close sidebar")}
            className="h-full flex-1 bg-black/35"
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      <main className="min-w-0 flex-1">
        <ChatPane
          onToggleSidebar={() => setSidebarOpen(true)}
          onToggleCollapse={toggleCollapse}
          onOpenSettings={openSettings}
          onAddWorkspace={openWorkspace}
        />
      </main>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
      <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />

      {error && (
        <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+12px)] z-[60] md:left-1/2 md:right-auto md:w-auto md:-translate-x-1/2">
          <div className="flex items-start gap-2 rounded-xl bg-ink px-3.5 py-2.5 text-[12px] text-canvas shadow-xl">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button type="button" onClick={clearError} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100" aria-label={t("关闭提示", "Dismiss")}>
              <IconClose size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
