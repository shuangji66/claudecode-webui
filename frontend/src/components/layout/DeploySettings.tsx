// 「设置 → 部署」：claude 二进制的版本管理。
//
// 应用不再内置 claude：二进制按版本从 npm 平台包下载到数据目录，按版本号隔离
// 存放，面板里可以切换生效版本。切换只影响之后新建的会话——已经在跑的 claude
// 进程把二进制载入了内存，不会也不需要热替换。

import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/attachments";
import { Select } from "../common/Select";
import { Button } from "../common/Button";
import { IconAlert, IconCheck, IconDownload, IconRefresh, IconTrash } from "../common/Icons";
import type { ClaudeJobPhase } from "../../transport/types";

const SOURCES = ["npmmirror", "official"] as const;

/** 阶段 → 文案。phase 是后端定义的字符串，映射不到时原样显示。 */
function phaseLabel(phase: ClaudeJobPhase, t: (zh: string, en: string) => string): string {
  switch (phase) {
    case "downloading":
      return t("下载中", "Downloading");
    case "extracting":
      return t("解包中", "Extracting");
    case "verifying":
      return t("校验并试运行", "Verifying");
    case "done":
      return t("安装完成", "Installed");
    case "error":
      return t("安装失败", "Failed");
    default:
      return phase;
  }
}

export function DeploySettings() {
  const t = useT();
  const claude = useAppStore((s) => s.claude);
  const claudeError = useAppStore((s) => s.claudeError);
  const loadClaudeStatus = useAppStore((s) => s.loadClaudeStatus);
  const checkClaudeUpdate = useAppStore((s) => s.checkClaudeUpdate);
  const installClaude = useAppStore((s) => s.installClaude);
  const setClaudeActive = useAppStore((s) => s.setClaudeActive);
  const setClaudeSource = useAppStore((s) => s.setClaudeSource);

  const [versions, setVersions] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [picked, setPicked] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    void loadClaudeStatus();
  }, [loadClaudeStatus]);

  // 安装完成后刷新可用列表，避免"刚装完还是旧的最新版"。
  useEffect(() => {
    if (claude?.job?.phase === "done") setInstalling(false);
    if (claude?.job?.phase === "error") setInstalling(false);
  }, [claude?.job?.phase]);

  const installed = claude?.installed ?? [];
  const active = claude?.active ?? "";
  const latest = claude?.latest ?? "";
  const job = claude?.job ?? null;
  const busy = installing || (job !== null && (job.phase === "downloading" || job.phase === "extracting" || job.phase === "verifying"));

  const check = async () => {
    setChecking(true);
    const res = await checkClaudeUpdate();
    setChecking(false);
    if (res) {
      setVersions(res.versions);
      if (!picked) setPicked(res.latest);
    }
  };

  const install = async (version: string) => {
    if (!version) return;
    setInstalling(true);
    await installClaude(version, claude?.source);
    setInstalling(false);
  };

  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.downloaded / job.total) * 100)) : 0;
  // 选中的版本已经装过时，安装按钮没有意义：直接显示「已安装」并禁用，
  // 免得点了只换来一条 409 错误。
  const pickedInstalled = installed.some((v) => v.version === picked);

  // 可安装列表：优先用「检查更新」的结果；没查过就只给最新版与已装版本之外的兜底。
  const candidates = versions.length > 0 ? versions : latest ? [latest] : [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-2">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{t("部署", "Deployment")}</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
          {t(
            "claude 二进制不再随应用分发，而是按版本下载到数据目录。安装或切换版本后，新开的对话使用新版本；已在运行的会话不受影响。",
            "The claude binary is no longer bundled. Versions are downloaded into the data directory. After installing or switching, new conversations use the new version; running sessions are unaffected.",
          )}
        </p>
      </div>

      {claude?.external_bin ? (
        <div className="flex items-start gap-2 rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-2">
          <IconCheck size={14} className="mt-0.5 shrink-0 text-ok" />
          <span>
            {t("当前使用外部 claude（CCWEB_CLAUDE_BIN）：", "Using an external claude (CCWEB_CLAUDE_BIN): ")}
            <code className="break-all font-mono text-[11px]">{claude.external_bin}</code>
            {t("。装了托管版本并切换后才会改用它；要回到外部二进制，去掉这个环境变量并重启。", ". Managed versions take over once installed and selected; remove the variable and restart to go back.")}
          </span>
        </div>
      ) : null}

      {installed.length === 0 && !busy && !claude?.external_bin && (
        <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink">
          <IconAlert size={14} className="mt-0.5 shrink-0 text-warn" />
          <span>{t("尚未安装任何版本，claude 会话无法启动。先选一个源并安装最新版。", "No version installed yet — conversations cannot start. Pick a source and install the latest version.")}</span>
        </div>
      )}

      <Section title={t("下载源", "Download source")} desc={t("两个源发布的是同一个平台包，下载后按官方 integrity（sha512）校验，镜像被换包会直接失败。", "Both sources publish the same platform package; downloads are verified against the official sha512 integrity, so a tampered mirror fails outright.")}>
        <Select
          value={claude?.source ?? "npmmirror"}
          ariaLabel={t("下载源", "Download source")}
          onChange={(v) => void setClaudeSource(v)}
          options={SOURCES.map((s) => ({
            value: s,
            label:
              s === "npmmirror"
                ? t("npmmirror 国内镜像（推荐）", "npmmirror (China mirror, recommended)")
                : t("官方 npm registry", "Official npm registry"),
          }))}
        />
        <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
          {t(
            "本机平台包：",
            "Platform package: ",
          )}
          <code className="font-mono">{claude?.platform || "—"}</code>
          {claude?.dir ? (
            <>
              {" · "}
              {t("目录：", "Dir: ")}
              <code className="break-all font-mono">{claude.dir}</code>
            </>
          ) : null}
        </p>
      </Section>

      <Section title={t("已安装版本", "Installed versions")} desc={t("切换版本只影响之后新建的会话。", "Switching only affects conversations started afterwards.")}>
        {installed.length === 0 ? (
          <p className="text-[11.5px] text-faint">{t("暂无已安装版本。", "Nothing installed yet.")}</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {installed.map((v) => {
              const isActive = v.version === active;
              return (
                <li key={v.version} className="flex items-center gap-2 px-3 py-2">
                  <span className="font-mono text-[12px] text-ink">{v.version}</span>
                  {isActive && (
                    <span className="flex items-center gap-1 rounded-full bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok">
                      <IconCheck size={10} />
                      {t("使用中", "In use")}
                    </span>
                  )}
                  {v.version === latest && !isActive && (
                    <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted">{t("最新", "Latest")}</span>
                  )}
                  <span className="ml-auto text-[10.5px] text-faint">{formatBytes(v.size)}</span>
                  <Button
                    size="sm"
                    variant={isActive ? "ghost" : "secondary"}
                    disabled={isActive || busy}
                    onClick={() => void setClaudeActive(v.version)}
                  >
                    {isActive ? t("当前", "Current") : t("切换到此版本", "Use this")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title={t("安装与更新", "Install & update")}
        desc={t("下载约 160 MB（gzip 平台包），解压后约 350 MB；安装完成后会跑一次 --version 确认可执行。", "About 160 MB gzip (≈350 MB unpacked); a --version run verifies the binary afterwards.")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon={<IconRefresh size={13} />} disabled={checking || busy} onClick={() => void check()}>
            {checking ? t("检查中…", "Checking…") : t("检查更新", "Check for updates")}
          </Button>
          {candidates.length > 0 && (
            <Select
              value={picked || candidates[0]}
              ariaLabel={t("要安装的版本", "Version to install")}
              onChange={setPicked}
              className="min-w-[9rem]"
              options={candidates.map((v) => ({
                value: v,
                label: installed.some((i) => i.version === v) ? `${v} · ${t("已安装", "installed")}` : v,
              }))}
            />
          )}
          <Button
            variant="primary"
            size="sm"
            icon={<IconDownload size={13} />}
            disabled={busy || !picked || pickedInstalled}
            onClick={() => void install(picked)}
          >
            {busy ? t("安装中…", "Installing…") : pickedInstalled ? t("已安装", "Installed") : t("安装", "Install")}
          </Button>
          {latest && active && latest !== active && !busy && (
            <Button variant="secondary" size="sm" onClick={() => void install(latest)}>
              {t(`更新到 ${latest}`, `Update to ${latest}`)}
            </Button>
          )}
        </div>

        {job && (
          <div className="mt-3 rounded-xl border border-line bg-canvas px-3 py-2.5">
            <div className="flex items-center gap-2 text-[11.5px]">
              <span className="font-mono text-ink">{job.version}</span>
              <span className={job.phase === "error" ? "text-danger" : "text-muted"}>{phaseLabel(job.phase, t)}</span>
              {job.total > 0 && job.phase !== "error" && (
                <span className="ml-auto text-[10.5px] text-faint">
                  {formatBytes(job.downloaded)} / {formatBytes(job.total)}
                </span>
              )}
            </div>
            {job.phase !== "error" && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10">
                <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${job.phase === "done" ? 100 : pct}%` }} />
              </div>
            )}
            {job.phase === "error" && job.error && (
              <p className="mt-1.5 break-words text-[10.5px] leading-relaxed text-danger">{job.error}</p>
            )}
          </div>
        )}
      </Section>

      {claudeError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-danger dark:bg-rose-950/30">{claudeError}</p>}

      <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-faint">
        <IconTrash size={12} className="mt-0.5 shrink-0" />
        {t(
          "旧版本不会自动清理：磁盘紧张时在数据目录下删除对应版本文件夹即可，正在使用中的版本不能删。",
          "Old versions are not pruned automatically. On low disk, delete the version folder in the data directory; the active one must stay.",
        )}
      </p>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="border-b border-line pb-6 last:border-b-0">
      <h4 className="text-[13px] font-medium text-ink">{title}</h4>
      {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
