// 首屏的「claude 未安装」提示。
//
// 应用不再内置 claude，全新部署时后端能起来但一个会话都开不出来。这里只负责
// 把人送到「设置 → 部署」——真正的下载与进度都在那一页，避免两处各写一套安装逻辑。

import { useT } from "../../lib/i18n";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Button";
import { IconAlert } from "../common/Icons";

export function ClaudeInstallPrompt({
  open,
  onClose,
  onGoDeploy,
}: {
  open: boolean;
  onClose: () => void;
  onGoDeploy: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("安装 claude", "Install claude")}
      title={t("claude 尚未安装", "claude is not installed")}
      icon={<IconAlert size={16} className="text-warn" />}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("稍后", "Later")}
          </Button>
          <Button variant="primary" onClick={onGoDeploy}>
            {t("去安装", "Open deployment")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[12.5px] leading-relaxed text-ink-2">
        <p>
          {t(
            "本应用不再随包分发 claude 二进制，需要先下载一个版本才能开始对话。",
            "This app no longer bundles the claude binary; download a version before starting a conversation.",
          )}
        </p>
        <ul className="space-y-1.5 rounded-xl border border-line bg-panel/60 px-3 py-2.5 text-[11.5px] text-muted">
          <li>· {t("在「设置 → 部署」选择下载源：默认 npmmirror 国内镜像，也可切官方 npm 源。", "Choose a source in Settings → Deployment: npmmirror by default, or the official npm registry.")}</li>
          <li>· {t("下载约 160 MB（gzip），解压后按版本号隔离存放，可随时切换。", "About 160 MB gzip; each version is stored separately and can be switched at any time.")}</li>
          <li>· {t("下载完成会按官方 sha512 校验并试运行一次，确认能执行才算装好。", "Downloads are verified against the official sha512 and smoke-tested before being marked installed.")}</li>
        </ul>
        <p className="text-[11px] text-faint">
          {t(
            "已有 claude 的机器也可以用 CCWEB_CLAUDE_BIN 指定路径，跳过这里的托管安装。",
            "On machines that already have claude, set CCWEB_CLAUDE_BIN to skip managed installation.",
          )}
        </p>
      </div>
    </Dialog>
  );
}
