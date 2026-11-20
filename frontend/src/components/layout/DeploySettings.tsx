// 「设置 → 部署」：claude 二进制的版本管理。
//
// 应用不再内置 claude：二进制按版本从 npm 平台包下载到数据目录，按版本号隔离
// 存放，面板里可以切换生效版本。切换只影响之后新建的会话——已经在跑的 claude
// 进程把二进制载入了内存，不会也不需要热替换。

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/attachments";
import { Select } from "../common/Select";
import { Button } from "../common/Button";
import { askConfirm } from "../common/SystemDialogs";
import { IconAlert, IconCheck, IconClose, IconDownload, IconRefresh, IconTrash } from "../common/Icons";
import type { ClaudeJobPhase, ClaudeSource, ClaudeVersion } from "../../transport/types";
import { Section } from "./settings/Section";

const SOURCES: { value: ClaudeSource; zh: string; en: string }[] = [
  { value: "npmmirror", zh: "阿里云镜像", en: "Alibaba Cloud mirror" },
  { value: "tencent", zh: "腾讯云镜像", en: "Tencent Cloud mirror" },
  { value: "huawei", zh: "华为云镜像", en: "Huawei Cloud mirror" },
  { value: "official", zh: "官方 npm registry", en: "Official npm registry" },
];

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
    case "cancelled":
      return t("已取消", "Cancelled");
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
  const cancelClaudeInstall = useAppStore((s) => s.cancelClaudeInstall);
  const deleteClaudeVersion = useAppStore((s) => s.deleteClaudeVersion);
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
    if (claude?.job?.phase === "done" || claude?.job?.phase === "error" || claude?.job?.phase === "cancelled") {
      setInstalling(false);
    }
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

  const removeVersion = async (v: ClaudeVersion) => {
    // 还有会话在这个二进制上跑时，删除会先把它们结束掉（后端会等进程退出再删目录），
    // 所以确认框必须把这个影响说清楚：那是用户正在跑的对话。
    const inUse = v.in_use ?? 0;
    const ok = await askConfirm({
      title: t("删除 claude 版本", "Delete claude version"),
      message:
        inUse > 0
          ? t(
              `删除 ${v.version}？有 ${inUse} 个对话正在使用该版本，它们会先被结束，然后移除该版本目录。`,
              `Delete ${v.version}? ${inUse} conversation(s) are still using it — they will be ended first, then the version directory is removed.`,
            )
          : t(
              `删除 ${v.version}？该版本目录会被移除；当前生效的版本不能删。`,
              `Delete ${v.version}? Its version directory is removed; the active version cannot be deleted.`,
            ),
      danger: true,
      confirmText: t("删除", "Delete"),
    });
    if (ok) await deleteClaudeVersion(v.version);
  };

  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.downloaded / job.total) * 100)) : 0;
  // 选中的版本已经装过时，安装按钮没有意义：直接显示「已安装」并禁用，
  // 免得点了只换来一条 409 错误。
  // 可安装列表：优先用「检查更新」的结果；没查过就只给最新版与已装版本之外的兜底。
  const candidates = versions.length > 0 ? versions : latest ? [latest] : [];
  // 下拉里显示的版本必须就是「安装」按钮会装的那个：picked 为空时下拉回落
  // candidates[0]，而按钮却因为 !picked 一直禁用，看起来像是装不了。
  const installVersion = picked || candidates[0] || "";
  const pickedInstalled = installed.some((v) => v.version === installVersion);

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-2">
      <h3 className="text-[15px] font-semibold text-ink">{t("部署", "Deployment")}</h3>

      {installed.length === 0 && !busy && (
        <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink">
          <IconAlert size={14} className="mt-0.5 shrink-0 text-warn" />
          <span>{t("尚未安装任何版本，claude 会话无法启动。先选一个源并安装最新版。", "No version installed yet — conversations cannot start. Pick a source and install the latest version.")}</span>
        </div>
      )}

      <Section title={t("下载源", "Download source")}>
        <Select
          value={claude?.source ?? "npmmirror"}
          ariaLabel={t("下载源", "Download source")}
          onChange={(v) => void setClaudeSource(v)}
          options={SOURCES.map((s) => ({ value: s.value, label: t(s.zh, s.en) }))}
        />
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
                  {(v.in_use ?? 0) > 0 && (
                    <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted">
                      {t(`${v.in_use} 个对话使用中`, `${v.in_use} in use`)}
                    </span>
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
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => void removeVersion(v)}
                      disabled={busy}
                      className="rounded-md p-1 text-muted hover:bg-black/5 hover:text-danger disabled:opacity-30"
                      aria-label={`${t("删除版本", "Delete version")} ${v.version}`}
                      title={t("删除版本", "Delete version")}
                    >
                      <IconTrash size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={t("安装与更新", "Install & update")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon={<IconRefresh size={13} />} disabled={checking || busy} onClick={() => void check()}>
            {checking ? t("检查中…", "Checking…") : t("检查更新", "Check for updates")}
          </Button>
          {candidates.length > 0 && (
            <Select
              value={installVersion}
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
            disabled={busy || !installVersion || pickedInstalled}
            onClick={() => void install(installVersion)}
          >
            {busy ? t("安装中…", "Installing…") : pickedInstalled ? t("已安装", "Installed") : t("安装", "Install")}
          </Button>
          {busy && (
            <Button variant="secondary" size="sm" icon={<IconClose size={13} />} onClick={() => void cancelClaudeInstall()}>
              {t("取消安装", "Cancel")}
            </Button>
          )}
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
            {job.phase !== "error" && job.phase !== "cancelled" && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10">
                <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${job.phase === "done" ? 100 : pct}%` }} />
              </div>
            )}
            {job.phase === "error" && job.error && (
              <p className="mt-1.5 break-words text-[10.5px] leading-relaxed text-danger">{job.error}</p>
            )}
            {job.phase === "cancelled" && (
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">{t("安装已取消，临时文件已清理。", "Installation cancelled; temporary files were cleaned up.")}</p>
            )}
          </div>
        )}
      </Section>

      {claudeError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-danger dark:bg-rose-950/30">{claudeError}</p>}
    </div>
  );
}


