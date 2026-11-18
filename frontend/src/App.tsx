import { lazy, Suspense, useEffect, useState } from "react";
import { useAppStore } from "./store/useAppStore";
import { getToken } from "./lib/runtime";
import { applyPreferences, watchSystemTheme } from "./lib/theme";
import { installAutofillGuard } from "./lib/autofill";
import { I18nProvider, useT } from "./lib/i18n";
import { Sidebar } from "./components/layout/Sidebar";
import { ChatPane } from "./components/chat/ChatPane";
import { ClaudeInstallPrompt } from "./components/layout/ClaudeInstallPrompt";
import { TokenGate } from "./components/layout/TokenGate";
import { SystemDialogs } from "./components/common/SystemDialogs";
import { BrandMark, IconClose, IconRetry } from "./components/common/Icons";
import type { FeatureKey } from "./lib/sidebarFeatures";

// 首屏只留壳层。设置抽屉（含全部设置页与提供商目录）、右侧栏（文件/Git/终端）、
// 两个对话框都在第一次打开时按需拉取——它们加起来占掉首屏包体的大半，
// 而打开对话本身一次都不需要。
const SettingsDrawer = lazy(() =>
  import("./components/layout/SettingsDrawer").then((m) => ({ default: m.SettingsDrawer })),
);
const WorkspaceDialog = lazy(() =>
  import("./components/layout/WorkspaceDialog").then((m) => ({ default: m.WorkspaceDialog })),
);
// 侧栏功能区打开的整页视图（插件 / MCP / 技能中心 / 自动化任务 / 历史记录）：
// 与对话区二选一渲染，同样按需拉取。
const FeaturePage = lazy(() =>
  import("./components/layout/FeaturePage").then((m) => ({ default: m.FeaturePage })),
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
  const [settingsTab, setSettingsTab] = useState<"general" | "models" | "proxy" | "deploy" | "access" | undefined>(undefined);
  const [installPromptDismissed, setInstallPromptDismissed] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  /** 侧栏功能区当前打开的整页视图；null = 回到对话区。 */
  const [view, setView] = useState<FeatureKey | null>(null);
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [rightOpen, setRightOpen] = useState(readRightOpen);
  const subagentView = useAppStore((s) => s.subagentView);

  // 三个模态首次打开才加载代码；之后保持挂载，行为和以前一致。
  const settingsMounted = useLazyMount(settingsOpen);
  const workspaceMounted = useLazyMount(workspaceOpen);
  const viewMounted = useLazyMount(view !== null);

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

  // 点了某条对话 / 「新对话」就回对话区：整页视图只是改道，不是另一个应用。
  // 必须和其它 hook 放在一起——跟在 `if (!info) return …` 后面会变成
  // 「首帧 12 个 hook、下一帧 13 个」，就是 React #310（踩过一次）。
  useEffect(() => {
    setView(null);
  }, [activeId]);

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

  // 任何 API 回 unauthorized（没凭据 / 密码被改 / 从 unix 入口换到 TCP 端口）
  // 都必须进入鉴权页，而不是停在「无法连接服务」或让界面继续显示错误条。
  // 本地即使存着旧凭据也要让用户重新输入。
  const unauthorized = (error ?? "").toLowerCase().includes("unauthorized");
  if (!loading && unauthorized) {
    return <TokenGate onSaved={() => setTokenEpoch((n) => n + 1)} stale={Boolean(getToken())} />;
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
  /**
   * 功能区入口：打开对应的整页视图（再点一次回到对话）。移动端先收起抽屉，
   * 整页视图就铺满屏幕；桌面端左侧栏保留、入口在原地高亮。
   */
  const openFeature = (key: FeatureKey) => {
    setSidebarOpen(false);
    setView((prev) => (prev === key ? null : key));
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
          onOpenFeature={openFeature}
          activeFeature={view}
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
              onOpenFeature={openFeature}
              activeFeature={view}
            />
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1">
        {/* 对话区始终挂载（切走只 hidden）：输入框草稿、滚动位置、WS 连接都留着，
            回到对话时不会重连、也不会被「回放转录」冲掉正在写的内容。 */}
        <div className={view ? "hidden" : "h-full"}>
          <ChatPane
            onToggleSidebar={() => setSidebarOpen(true)}
            onAddWorkspace={openWorkspace}
            rightOpen={rightOpen}
            onToggleRight={toggleRight}
          />
        </div>
        {view && (
          <div className="h-full">
            <Suspense fallback={null}>
              {viewMounted && (
                <FeaturePage view={view} cwd={rightCwd} onClose={() => setView(null)} onOpenSidebar={() => setSidebarOpen(true)} />
              )}
            </Suspense>
          </div>
        )}
      </main>

      {/* 标签页由右侧栏自己管：文件 / Git / 每个终端各一个标签，切走不卸载。
          功能区整页视图打开时只隐藏（`display: none`）不卸载——卸载等于 SIGHUP
          掉里面的终端 shell。 */}
      {rightOpen && (
        <div className={view ? "hidden" : "contents"}>
          <Suspense fallback={null}>
            <RightSidebar cwd={rightCwd} onClose={() => setRightOpen(false)} />
          </Suspense>
        </div>
      )}

      <Suspense fallback={null}>
        {settingsMounted && (
          <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} />
        )}
        {workspaceMounted && <WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />}
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
