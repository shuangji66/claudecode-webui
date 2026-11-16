// 首屏的「claude 未安装」提示。
//
// 应用不再内置 claude，全新部署时后端能起来但一个会话都开不出来。这里只负责
// 把人送到「设置 → 部署」——真正的下载与进度都在那一页，避免两处各写一套安装逻辑。
//
// 版式刻意用居中的窄卡片（图标 / 标题 / 一句话 / 等宽按钮），而不是默认的
// 「左对齐标题 + 通栏分隔线」：内容只有一行，套通用外壳会显得又宽又空。

import { useT } from "../../lib/i18n";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Button";
import { IconAlert, IconClose } from "../common/Icons";

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
      label={t("claude 未安装", "claude is not installed")}
      size="sm"
      bare
    >
      <div className="relative flex flex-col items-center px-6 pb-5 pt-8 text-center">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("关闭", "Close")}
          className="absolute right-2.5 top-2.5 rounded-lg p-1.5 text-muted hover:bg-black/5 hover:text-ink"
        >
          <IconClose size={16} />
        </button>
        <IconAlert size={26} className="text-warn" />
        <h2 className="mt-2.5 text-[15px] font-semibold text-ink">{t("claude 未安装", "claude is not installed")}</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {t("安装一个版本后才能开始对话。", "Install a version before starting a conversation.")}
        </p>
        <div className="mt-5 flex w-full gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            {t("稍后", "Later")}
          </Button>
          <Button variant="primary" className="flex-1" onClick={onGoDeploy}>
            {t("去安装", "Install")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
