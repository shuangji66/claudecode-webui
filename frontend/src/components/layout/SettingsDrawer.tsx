import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../lib/i18n";
import { Dialog } from "../common/Dialog";
import { Section } from "./settings/Section";
import { BrandMark, IconDownload, IconGitHub, IconGlobe, IconInfo, IconLock, IconPlugin, IconSettings, IconShield, IconSpark, IconWrench } from "../common/Icons";

type Tab = "general" | "models" | "skills" | "plugins" | "mcp" | "proxy" | "deploy" | "access" | "about";

// 每页一个 chunk：打开设置只看得到当前这一页，模型页（含预置提供商目录）
// 与插件/MCP/技能页都没有理由跟着首开一起下发。
const GeneralSettings = lazy(() => import("./settings/GeneralSettings").then((m) => ({ default: m.GeneralSettings })));
const ModelsSettings = lazy(() => import("./settings/ModelsSettings").then((m) => ({ default: m.ModelsSettings })));
const ProxySettings = lazy(() => import("./settings/ProxySettings").then((m) => ({ default: m.ProxySettings })));
const SkillsSettings = lazy(() => import("./SkillsSettings").then((m) => ({ default: m.SkillsSettings })));
const PluginsSettings = lazy(() => import("./PluginsSettings").then((m) => ({ default: m.PluginsSettings })));
const McpSettings = lazy(() => import("./McpSettings").then((m) => ({ default: m.McpSettings })));
const DeploySettings = lazy(() => import("./DeploySettings").then((m) => ({ default: m.DeploySettings })));
const AccessSettings = lazy(() => import("./settings/AccessSettings").then((m) => ({ default: m.AccessSettings })));

const PANE_SCROLL =
  "dsh-scroll h-full overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-4 md:px-8 md:pb-8 md:pt-6";
const PANE_FLEX = "flex h-full min-h-0 flex-col px-4 pt-4 md:px-8 md:pt-6";

export function SettingsDrawer({
  open,
  onClose,
  initialTab,
  cwd,
}: {
  open: boolean;
  onClose: () => void;
  /** 从侧栏「有更新」等入口直接落到某一页。 */
  initialTab?: Tab;
  /** 当前工作区，技能页用它读写项目里的 .claude/skills。 */
  cwd?: string;
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

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("设置", "Settings")}
      title={t("设置", "Settings")}
      size="xl"
      bare
      fullScreen
      panelClassName="h-[100dvh] max-h-[100dvh] rounded-none md:h-[82vh] md:max-h-[84vh] md:rounded-2xl md:max-w-[900px]"
    >
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-2 md:w-48 md:flex-col md:border-b-0 md:border-r md:px-2.5 md:py-3">
          <NavItem active={tab === "general"} icon={<IconSettings size={16} />} onClick={() => setTab("general")}>
            {t("通用", "General")}
          </NavItem>
          <NavItem active={tab === "models"} icon={<IconSpark size={16} />} onClick={() => setTab("models")}>
            {t("模型", "Models")}
          </NavItem>
          <NavItem active={tab === "skills"} icon={<IconWrench size={16} />} onClick={() => setTab("skills")}>
            {t("技能", "Skills")}
          </NavItem>
          <NavItem active={tab === "plugins"} icon={<IconPlugin size={16} />} onClick={() => setTab("plugins")}>
            {t("插件", "Plugins")}
          </NavItem>
          <NavItem active={tab === "mcp"} icon={<IconGlobe size={16} />} onClick={() => setTab("mcp")}>
            {t("MCP", "MCP")}
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
          <Pane active={tab === "general"} mount={visited.has("general")}>
            <GeneralSettings />
          </Pane>
          <Pane active={tab === "models"} mount={visited.has("models")} flex>
            <ModelsSettings />
          </Pane>
          <Pane active={tab === "skills"} mount={visited.has("skills")} flex>
            <SkillsSettings cwd={cwd ?? ""} />
          </Pane>
          <Pane active={tab === "plugins"} mount={visited.has("plugins")}>
            <PluginsSettings cwd={cwd ?? ""} />
          </Pane>
          <Pane active={tab === "mcp"} mount={visited.has("mcp")} flex>
            <McpSettings cwd={cwd ?? ""} />
          </Pane>
          <Pane active={tab === "proxy"} mount={visited.has("proxy")}>
            <ProxySettings />
          </Pane>
          <Pane active={tab === "deploy"} mount={visited.has("deploy")}>
            <DeploySettings />
          </Pane>
          <Pane active={tab === "access"} mount={visited.has("access")}>
            <AccessSettings />
          </Pane>
          <Pane active={tab === "about"} mount={visited.has("about")}>
            <AboutSettings />
          </Pane>
        </div>
      </div>
    </Dialog>
  );
}

/** 一页内容：没打开过的页不挂载；切走只 hidden，滚动位置与表单状态都留着。 */
function Pane({
  active,
  mount,
  flex = false,
  children,
}: {
  active: boolean;
  mount: boolean;
  flex?: boolean;
  children: ReactNode;
}) {
  if (!mount) return null;
  return (
    <div className={active ? (flex ? PANE_FLEX : PANE_SCROLL) : "hidden"}>
      <Suspense fallback={null}>{children}</Suspense>
    </div>
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

