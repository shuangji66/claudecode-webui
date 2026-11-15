import { useEffect, useState } from "react";
import { useAppStore } from "./store/useAppStore";
import { getToken } from "./lib/runtime";
import { Sidebar } from "./components/layout/Sidebar";
import { ChatPane } from "./components/chat/ChatPane";
import { SettingsDrawer } from "./components/layout/SettingsDrawer";
import { TokenGate } from "./components/layout/TokenGate";

export default function App() {
  const info = useAppStore((s) => s.info);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const clearError = useAppStore((s) => s.clearError);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenEpoch, setTokenEpoch] = useState(0);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap, tokenEpoch]);

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 text-sm text-slate-500 dark:bg-slate-950">
        {loading ? "正在连接服务…" : error ? `连接失败：${error}` : "加载中…"}
      </div>
    );
  }

  // 后端要求鉴权但本地没有令牌：先拦一道。注意此判断放在 info 之后，
  // 因为 auth_required 需要从 /api/health + /api/info 得知。
  if (info.auth_required && !getToken()) {
    return (
      <TokenGate
        onSaved={() => {
          setTokenEpoch((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="flex h-full bg-white dark:bg-slate-950">
      <div className="hidden md:block">
        <Sidebar />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-30 flex md:hidden">
          <div className="h-full" onClick={(e) => e.stopPropagation()}>
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </div>
          <div className="flex-1 bg-black/30" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      <main className="min-w-0 flex-1">
        <ChatPane onToggleSidebar={() => setSidebarOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
      </main>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {error && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-rose-600 px-4 py-2 text-xs text-white shadow-lg">
          {error}
          <button type="button" onClick={clearError} className="ml-3 underline">
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
