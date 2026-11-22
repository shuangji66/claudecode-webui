import { lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../lib/i18n";
import { Section } from "./settings/Section";
import { SettingsPane, SettingsSurface } from "./settings/SettingsSurface";
import { BrandMark, IconDownload, IconFolder, IconGitHub, IconInfo, IconLock, IconSettings, IconShield, IconTerminal } from "../common/Icons";

// 技能 / 模型 / 插件 / MCP 四页的入口都已移到左侧栏功能区（整页视图，见 FeaturePage），
// 这里只留应用自身的设置。加页签照旧：类型、nav、Pane 各一行，页面自己 lazy 加载。
type Tab = "general" | "cli" | "dirs" | "proxy" | "deploy" | "access" | "about";

// 每页一个 chunk：打开设置只看得到当前这一页。
const GeneralSettings = lazy(() => import("./settings/GeneralSettings").then((m) => ({ default: m.GeneralSettings })));
const CliSettings = lazy(() => import("./settings/CliSettings").then((m) => ({ default: m.CliSettings })));
const ProxySettings = lazy(() => import("./settings/ProxySettings").then((m) => ({ default: m.ProxySettings })));
const DeploySettings = lazy(() => import("./DeploySettings").then((m) => ({ default: m.DeploySettings })));
const AccessSettings = lazy(() => import("./settings/AccessSettings").then((m) => ({ default: m.AccessSettings })));
const DirsSettings = lazy(() => import("./settings/DirsSettings").then((m) => ({ default: m.DirsSettings })));

export function SettingsDrawer({
  open,
  onClose,
  initialTab,
}: {
  open: boolean;
  onClose: () => void;
  /** 从侧栏「有更新」等入口直接落到某一页。 */
  initialTab?: Tab;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  // 打开过的页才挂载：各页的 useEffect 一挂载就发请求（技能、插件目录、MCP、搜索），
  // 全部常驻会让「打开设置」变成一次并发拉取，插件目录首次还可能联网十几秒。
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([initialTab ?? "general"]));

  // 每次打开都按入口指定的页签重置：否则上次停在「模型」，
  // 点「有更新」进来还是模型页。
  useEffect(() => {
    if (open) setTab(initialTab ?? "general");
  }, [open, initialTab]);

  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  /**
   * 移动端导航是一条横向滚动条（桌面是竖列）：七项在 360px 宽里放不下，
   * `初始页签` 落在「部署 / 访问 / 关于」时，选中项可能整颗在屏幕外——用户
   * 看不到「现在在哪一页」。切页签后把当前项滚进视野（对齐 DSH 的 navCell）。
   *
   * 只在打开时与切换时做；`block: "nearest"` 保证桌面竖列里不会带着整页跳。
   */
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    // jsdom / 老 WebView 没有 scrollIntoView：判一下，别为它报错。
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [open, tab]);

  if (!open) return null;

  return (
    <SettingsSurface open={open} onClose={onClose} title={t("设置", "Settings")}>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 桌面端导航宽 136px（w-34）：192px 时那列文字只占一半、留白过大，
            分隔线离内容太远；标签最长只有两个字（MCP 三个），收窄后仍然一行放得下。 */}
        <nav
          ref={navRef}
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-2 md:w-34 md:flex-col md:border-b-0 md:border-r md:px-2.5 md:py-3"
        >
          <NavItem active={tab === "general"} icon={<IconSettings size={16} />} onClick={() => setTab("general")}>
            {t("通用", "General")}
          </NavItem>
          <NavItem active={tab === "cli"} icon={<IconTerminal size={16} />} onClick={() => setTab("cli")}>
            {t("CLI", "CLI")}
          </NavItem>
          <NavItem active={tab === "dirs"} icon={<IconFolder size={16} />} onClick={() => setTab("dirs")}>
            {t("目录", "Folders")}
          </NavItem>
          <NavItem active={tab === "proxy"} icon={<IconShield size={16} />} onClick={() => setTab("proxy")}>
            {t("代理", "Proxy")}
          </NavItem>
          <NavItem active={tab === "deploy"} icon={<IconDownload size={16} />} onClick={() => setTab("deploy")}>
            {t("部署", "Deployment")}
          </NavItem>
          <NavItem active={tab === "access"} icon={<IconLock size={16} />} onClick={() => setTab("access")}>
            {t("访问", "Access")}
          </NavItem>
          <NavItem active={tab === "about"} icon={<IconInfo size={16} />} onClick={() => setTab("about")}>
            {t("关于", "About")}
          </NavItem>
        </nav>

        <div className="min-h-0 flex-1">
          <SettingsPane active={tab === "general"} mount={visited.has("general")}>
            <GeneralSettings />
          </SettingsPane>
          <SettingsPane active={tab === "cli"} mount={visited.has("cli")}>
            <CliSettings />
          </SettingsPane>
          <SettingsPane active={tab === "dirs"} mount={visited.has("dirs")}>
            <DirsSettings />
          </SettingsPane>
          <SettingsPane active={tab === "proxy"} mount={visited.has("proxy")}>
            <ProxySettings />
          </SettingsPane>
          <SettingsPane active={tab === "deploy"} mount={visited.has("deploy")}>
            <DeploySettings />
          </SettingsPane>
          <SettingsPane active={tab === "access"} mount={visited.has("access")}>
            <AccessSettings />
          </SettingsPane>
          <SettingsPane active={tab === "about"} mount={visited.has("about")}>
            <AboutSettings />
          </SettingsPane>
        </div>
      </div>
    </SettingsSurface>
  );
}

export function AboutSettings() {
  const t = useT();
  const info = useAppStore((s) => s.info);
  const version = info?.version ? `v${info.version}` : "";
  return (
    <div className="mx-auto max-w-2xl space-y-7">
      <div className="flex items-start gap-3">
        <BrandMark size={40} className="shrink-0 text-ink" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[15px] font-semibold text-ink">Claude Code WebUI</h3>
            <a
              href="https://github.com/shuangji66/claudecode-webui"
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("GitHub 仓库", "GitHub repository")}
              title="github.com/shuangji66/claudecode-webui"
              className="-my-0.5 rounded-md p-1 text-muted transition hover:bg-panel-strong hover:text-ink"
            >
              <IconGitHub size={15} />
            </a>
          </div>
          {version && <p className="text-[11.5px] text-muted">{version}</p>}
        </div>
      </div>

      <p className="text-[12.5px] leading-relaxed text-ink-2">
        {t(
          "把本地 claude CLI 包成可视化 Web 控制台：消息、思考、工具卡片、diff 与审批全部结构化渲染。",
          "A visual console for the local claude CLI: messages, thinking, tool cards, diffs and approvals rendered structurally.",
        )}
      </p>

      <Section
        title={t("致谢", "Credits")}
        desc={t("这个项目的交互与协议细节大量参考了下面几项工作。", "The interaction and protocol details here borrow heavily from the work below.")}
      >
        <ul className="space-y-2 text-[12px] leading-relaxed text-ink-2">
          <li>
            <span className="font-medium text-ink">DeepSeek</span>
            {t(" — 模型与技术支持", " — models and technical support")}
          </li>
          <li>
            <span className="font-medium text-ink">DeepSeek Harness</span>
            {t(" — 界面交互、消息模型与子代理设计的参考", " — reference for the UI, message model and subagent design")}
          </li>
          <li>
            <span className="font-medium text-ink">dsh-better-sidebar</span>
            {t(" — 右侧栏 Git 面板的交互与命令安全思路", " — the Git panel's interaction and command-safety rules")}
          </li>
        </ul>
      </Section>

    </div>
  );
}


function NavItem({ active, icon, onClick, children }: { active: boolean; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] transition ${
        active ? "bg-panel-strong font-medium text-ink" : "text-muted hover:bg-black/5 hover:text-ink"
      }`}
    >
      <span className={active ? "text-brand" : ""}>{icon}</span>
      {children}
    </button>
  );
}

