// 侧栏功能区打开的整页视图：直接接管「左侧栏以外的剩余区域」（对齐 DSH），
// 不再是居中弹窗——弹窗会盖住对话区、还得先关掉才能接着干活。
//
// 左侧栏始终保留：入口本身在原地高亮（`activeFeature`），再点一次就回到对话。
//
// 懒加载照旧：每份页面各自 `lazy()`，只有真正被打开过的那一份才下发。

import { lazy, Suspense, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { FeatureKey } from "../../lib/sidebarFeatures";
import { IconClose, IconPanel } from "../common/Icons";
import { SETTINGS_PANE_FLEX, SETTINGS_PANE_SCROLL } from "./settings/SettingsSurface";

const ModelsSettings = lazy(() => import("./settings/ModelsSettings").then((m) => ({ default: m.ModelsSettings })));
const PluginsSettings = lazy(() => import("./PluginsSettings").then((m) => ({ default: m.PluginsSettings })));
const McpSettings = lazy(() => import("./McpSettings").then((m) => ({ default: m.McpSettings })));
const SkillsSettings = lazy(() => import("./SkillsSettings").then((m) => ({ default: m.SkillsSettings })));
const SchedulePage = lazy(() => import("./SchedulePage").then((m) => ({ default: m.SchedulePage })));
const HistoryPage = lazy(() => import("./HistoryPage").then((m) => ({ default: m.HistoryPage })));

/**
 * 整页视图的外壳：与对话区共用 `h-14` 表头高度（三栏分隔线才对得齐），
 * 右上角是页面自己的动作，最右侧一颗「回到对话」。
 */
export function PageShell({
  title,
  onClose,
  onOpenSidebar,
  actions,
  children,
  bodyClassName = "dsh-scroll min-h-0 flex-1 overflow-y-auto",
}: {
  title: string;
  /** 回到对话；不传时不渲染右上角的关闭键（页面单独挂载时没有「上一页」）。 */
  onClose?: () => void;
  /** 移动端抽屉入口：整页视图铺满屏幕时，页头是唯一还能打开左侧栏的地方。 */
  onOpenSidebar?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  const t = useT();
  return (
    // 移动端铺满整个视口（左侧栏这时是抽屉），桌面端只占左侧栏右边的区域。
    <section className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="safe-top shrink-0 border-b border-line bg-canvas md:pt-0">
        <div className="flex h-14 items-center gap-2 px-3 md:px-4">
          {onOpenSidebar && (
            <button
              type="button"
              onClick={onOpenSidebar}
              className="rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink md:hidden"
              aria-label={t("打开侧栏", "Open sidebar")}
            >
              <IconPanel size={18} />
            </button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{title}</h1>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
              aria-label={t("关闭", "Close")}
              title={t("回到对话", "Back to chat")}
            >
              <IconClose size={18} />
            </button>
          )}
        </div>
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** 插件 / MCP / 技能中心：三个管理页共用设置页的内边距，只是没有设置弹窗的导航。 */
export function FeaturePage({
  view,
  cwd,
  onClose,
  onOpenSidebar,
}: {
  view: FeatureKey;
  /** 当前工作区：技能页与 MCP 页用它读写项目级配置。 */
  cwd: string;
  onClose: () => void;
  /** 移动端抽屉入口（见 PageShell）。 */
  onOpenSidebar?: () => void;
}) {
  const t = useT();

  if (view === "schedules") {
    return (
      <Suspense fallback={null}>
        <SchedulePage onClose={onClose} onOpenSidebar={onOpenSidebar} />
      </Suspense>
    );
  }
  if (view === "history") {
    return (
      <Suspense fallback={null}>
        <HistoryPage onClose={onClose} onOpenSidebar={onOpenSidebar} />
      </Suspense>
    );
  }
  // 模型页与 MCP 页自己渲染 PageShell（页头右侧各有一个整体动作：保存 / 添加），
  // 这里不再套一层外壳——套两层会出现两个标题、两倍内边距。
  if (view === "models") {
    return (
      <Suspense fallback={null}>
        <ModelsSettings onClose={onClose} onOpenSidebar={onOpenSidebar} />
      </Suspense>
    );
  }
  if (view === "mcp") {
    return (
      <Suspense fallback={null}>
        <McpSettings cwd={cwd} onClose={onClose} onOpenSidebar={onOpenSidebar} />
      </Suspense>
    );
  }

  const title =
    view === "plugins" ? t("插件", "Plugins") : t("技能中心", "Skills");

  // 滚动归谁：技能页自己就是 flex 列、内部有滚动区；插件页是一整段普通内容
  // （根节点只有 `space-y-3`），必须由外层给滚动容器——否则内容超出视口就再也够不到。
  const bodyClassName = view === "plugins" ? SETTINGS_PANE_SCROLL : SETTINGS_PANE_FLEX;

  return (
    <PageShell title={title} onClose={onClose} onOpenSidebar={onOpenSidebar} bodyClassName={bodyClassName}>
      <Suspense fallback={null}>
        {view === "plugins" ? <PluginsSettings cwd={cwd} /> : <SkillsSettings cwd={cwd} />}
      </Suspense>
    </PageShell>
  );
}
