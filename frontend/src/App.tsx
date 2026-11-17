import { lazy, Suspense, useEffect, useState } from "react";
import { useAppStore } from "./store/useAppStore";
import { getToken, setToken } from "./lib/runtime";
import { applyPreferences, watchSystemTheme } from "./lib/theme";
import { installAutofillGuard } from "./lib/autofill";
import { I18nProvider, useT } from "./lib/i18n";
import { Sidebar } from "./components/layout/Sidebar";
import { ChatPane } from "./components/chat/ChatPane";
import { ClaudeInstallPrompt } from "./components/layout/ClaudeInstallPrompt";
import { TokenGate } from "./components/layout/TokenGate";
import { SystemDialogs } from "./components/common/SystemDialogs";
import { BrandMark, IconClose, IconRetry } from "./components/common/Icons";

// 首屏只留壳层。设置抽屉（含全部设置页与提供商目录）、右侧栏（文件/Git/终端）、
// 两个对话框都在第一次打开时按需拉取——它们加起来占掉首屏包体的大半，
// 而打开对话本身一次都不需要。
const SettingsDrawer = lazy(() =>
  import("./components/layout/SettingsDrawer").then((m) => ({ default: m.SettingsDrawer })),
);
const WorkspaceDialog = lazy(() =>
  import("./components/layout/WorkspaceDialog").then((m) => ({ default: m.WorkspaceDialog })),
);
const HistoryDialog = lazy(() =>
  import("./components/layout/HistoryDialog").then((m) => ({ default: m.HistoryDialog })),
);
const RightSidebar = lazy(() => import("./components/right/RightSidebar").then((m) => ({ default: m.RightSidebar })));

/** 首次打开后才挂载，之后保持挂载：配合 lazy，关闭再打开不会丢表单状态。 */
function useLazyMount(flag: boolean): boolean {
  const [mounted, setMounted] = useState(flag);
  useEffect(() => {
    if (flag) setMounted(true);
  }, [flag]);
  return mounted || flag;
}

const COLLAPSE_KEY = "ccweb-sidebar-collapsed";
const RIGHT_OPEN_KEY = "ccweb-right-open";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function readRightOpen(): boolean {
  try {
    return localStorage.getItem(RIGHT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const settings = useAppStore((s) => s.settings);
  const locale = settings?.locale === "en" ? "en" : "zh";

  useEffect(() => {
    applyPreferences(settings);
    return watchSystemTheme(() => applyPreferences(settings));
  }, [settings]);

  // 地址/密钥输入框不该被浏览器当成登录表单；只装一次，动态节点由 observer 处理。
  useEffect(() => installAutofillGuard(), []);

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
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);
  const conversations = useAppStore((s) => s.conversations);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "models" | "proxy" | "deploy" | undefined>(undefined);
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [rightOpen, setRightOpen] = useState(readRightOpen);
  const subagentView = useAppStore((s) => s.subagentView);

  // 三个模态首次打开才加载代码；之后保持挂载，行为和以前一致。
  const settingsMounted = useLazyMount(settingsOpen);
  const workspaceMounted = useLazyMount(workspaceOpen);
  const historyMounted = useLazyMount(historyOpen);

  // 聊天里点「查看对话」：右侧栏可能还没开，这里替用户打开。
  useEffect(() => {
    if (subagentView) setRightOpen(true);
  }, [subagentView]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap, tokenEpoch]);

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_OPEN_KEY, rightOpen ? "1" : "0");
    } catch {
      /* 隐私模式 */
    }
  }, [rightOpen]);

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
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => void bootstrap()}
              className="flex items-center gap-1.5 rounded-full border border-line-strong px-4 py-2 text-[12px] font-medium text-ink hover:bg-panel-strong"
            >
              <IconRetry size={14} />
              {t("重试", "Retry")}
            </button>
            {/* 令牌过期/填错时只会显示「无法连接服务」，没有入口换一个 —— 只能清缓存。
                这里直接把本地令牌清掉，回到令牌门。 */}
            {(error ?? "").toLowerCase().includes("unauthorized") && (
              <button
                type="button"
                onClick={() => {
                  setToken("");
                  setTokenEpoch((n) => n + 1);
                }}
                className="rounded-full border border-line-strong px-4 py-2 text-[12px] font-medium text-ink hover:bg-panel-strong"
              >
                {t("重新输入令牌", "Enter a new token")}
              </button>
            )}
          </div>
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
    setSettingsTab(undefined);
    setSettingsOpen(true);
  };
  const openDeploy = () => {
    setSidebarOpen(false);
    setSettingsTab("deploy");
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

  const rightCwd =
    conversations.find((c) => c.id === activeId)?.cwd ??
    sessions.find((s) => s.id === activeId)?.cwd ??
    currentWorkspace;
  const toggleRight = () => setRightOpen((v) => !v);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-canvas">
      <div className="hidden md:flex">
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          onOpenSettings={openSettings}
          onOpenDeploy={openDeploy}
          onAddWorkspace={openWorkspace}
          onOpenHistory={openHistory}
        />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          {/* 遮罩必须自己铺满视口：不要依赖 flex-1，否则侧栏宽度变化时会留出未遮罩的条带。 */}
          <button
            type="button"
            aria-label={t("关闭侧栏", "Close sidebar")}
            className="absolute inset-0 h-full w-full bg-black/35"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-10 h-full w-[86vw] max-w-[330px] shadow-2xl">
            <Sidebar
              onClose={() => setSidebarOpen(false)}
              onOpenSettings={openSettings}
              onOpenDeploy={openDeploy}
              onAddWorkspace={openWorkspace}
              onOpenHistory={openHistory}
            />
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1">
        <ChatPane
          onToggleSidebar={() => setSidebarOpen(true)}
          onToggleCollapse={toggleCollapse}
          onAddWorkspace={openWorkspace}
          rightOpen={rightOpen}
          onToggleRight={toggleRight}
        />
      </main>

      {/* 标签页由右侧栏自己管：文件 / Git / 每个终端各一个标签，切走不卸载。 */}
      {rightOpen && (
        <Suspense fallback={null}>
          <RightSidebar cwd={rightCwd} onClose={() => setRightOpen(false)} />
        </Suspense>
      )}

      <Suspense fallback={null}>
        {settingsMounted && (
          <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} cwd={rightCwd} />
        )}
        {workspaceMounted && <WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />}
        {historyMounted && <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />}
      </Suspense>
      {/* 一个版本都没装：后端能起来，但开不了会话，首屏直接把人送到部署页 */}
      <ClaudeInstallPrompt
        open={Boolean(info && info.claude_installed === false) && !installPromptDismissed}
        onClose={() => setInstallPromptDismissed(true)}
        onGoDeploy={() => {
          setInstallPromptDismissed(true);
          openDeploy();
        }}
      />
      {/* 全局确认 / 输入框（替代 window.confirm / prompt），由这里挂一次 */}
      <SystemDialogs />

      {/* 提示条放顶部：底部会压住输入卡和它的提示行，而错误恰恰需要用户一边看一边改。 */}
      {error && (
        <div className="fixed inset-x-3 top-[calc(env(safe-area-inset-top,0px)+68px)] z-[45] md:left-1/2 md:right-auto md:w-auto md:-translate-x-1/2">
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
