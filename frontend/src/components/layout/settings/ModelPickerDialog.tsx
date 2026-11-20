// 「获取可用模型」的选择弹窗：搜索 + 全选 + 勾选，确认时才把结果写进提供商。
//
// 以前这一整块是嵌在提供商卡片里的内联面板（`max-h-52` 的一小条）：网关常返回
// 几十上百个模型（实测一个中转给 9~40 个，官方目录更多），在卡片里滚那一小条
// 既看不清、又会把下面的模型列表挤到屏幕外。抽成弹窗后选择区拿到整块高度，
// 并且能在确认前反复改选（取消不改任何配置）。

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../lib/i18n";
import { formatCapacity } from "../../../lib/providerForm";
import type { GatewayModel } from "../../../transport/types";
import { Button } from "../../common/Button";
import { Dialog } from "../../common/Dialog";

export function ModelPickerDialog({
  open,
  onClose,
  providerName,
  models,
  selected,
  loading,
  error,
  attempts,
  raw,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  /** 标题里显示的提供商名（可能为空，回落到 ID）。 */
  providerName: string;
  /** 网关返回的完整目录（未过滤）。 */
  models: GatewayModel[];
  /** 提供商当前已有的模型：打开时默认勾上（再加一次不会重复）。 */
  selected: string[];
  /** 正在向网关拉列表。 */
  loading: boolean;
  error: string | null;
  attempts: { path: string; status: number; note: string }[];
  raw: string;
  /** 只回传勾选的 model id；元数据由调用方按网关字段补。 */
  onAdd: (ids: string[]) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selected));

  // 每次打开都从「当前已有的模型 + 空搜索」重来：上一次关掉前的勾选是草稿，
  // 留到下一次会让人以为新拉的目录里那些模型已经加过了。
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setPicked(new Set(selected));
    // selected 每次渲染都是新数组，只跟着 open 重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q) || (m.display_name ?? "").toLowerCase().includes(q));
  }, [models, search]);

  // 全选只作用于**当前筛选出的那些**：搜 `deepseek` 时点全选，不该把目录里
  // 另一个厂商的模型也一起勾上。
  const allSelected = filtered.length > 0 && filtered.every((m) => picked.has(m.id));
  const toggleAll = () => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const m of filtered) {
        if (allSelected) next.delete(m.id);
        else next.add(m.id);
      }
      return next;
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t("选择模型", "Choose models")}
      title={t("选择模型", "Choose models")}
      description={
        providerName
          ? // 「已在列表里的默认勾选」要说出来，否则用户会以为那些是被网关标出来的。
            t(`从「${providerName}」的网关目录里挑选；已经添加过的默认勾选。`, `Pick from the gateway catalog of "${providerName}"; already-added models start checked.`)
          : t("从网关目录里挑选；已经添加过的默认勾选。", "Pick from the gateway catalog; already-added models start checked.")
      }
      size="lg"
      bodyScroll={false}
      bodyClassName="flex flex-col"
      footer={
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
            {t(`已选 ${picked.size} 个`, `${picked.size} selected`)}
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t("取消", "Cancel")}
          </Button>
          <Button variant="primary" disabled={picked.size === 0} onClick={() => onAdd([...picked])}>
            {t("添加所选", "Add selected")}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("搜索模型…", "Search models…")}
            aria-label={t("搜索模型", "Search models")}
            // 弹窗一打开就聚焦搜索框：目录动辄几十条，键盘直接筛比找滚动条快。
            autoFocus
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1.5 text-[11.5px] outline-none focus:border-brand/60"
          />
          <Button size="sm" variant="secondary" disabled={filtered.length === 0} onClick={toggleAll}>
            {allSelected ? t("取消全选", "Clear all") : t("全选", "Select all")}
          </Button>
        </div>

        <div className="dsh-scroll mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {loading && <p className="px-2 py-6 text-center text-[11px] text-muted">{t("正在获取模型列表…", "Fetching models…")}</p>}
          {!loading && filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-[11px] text-muted">
              {models.length === 0 ? t("网关没有返回任何模型。", "The gateway returned no models.") : t("没有匹配的模型。", "No matching models.")}
            </p>
          )}
          {!loading &&
            filtered.map((m) => (
              <label key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px] hover:bg-panel-strong">
                <input
                  type="checkbox"
                  className="accent-[var(--c-brand)]"
                  checked={picked.has(m.id)}
                  onChange={(e) => {
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      return next;
                    });
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{m.id}</span>
                {m.context_length ? <span className="shrink-0 text-[10px] text-faint">{formatCapacity(m.context_length)}</span> : null}
                {m.display_name && <span className="max-w-[40%] truncate text-[10px] text-muted">{m.display_name}</span>}
              </label>
            ))}
        </div>

        {!loading && error && (
          <div className="mt-2 shrink-0 rounded-md bg-amber-50 px-2 py-1.5 text-[10.5px] text-warn dark:bg-amber-950/20">
            <p className="break-words">{error}</p>
            {attempts.length > 0 && <p className="mt-0.5 font-mono opacity-80">{attempts.map((a) => `${a.path} → ${a.status || "-"}`).join(" · ")}</p>}
            {raw && (
              <details className="mt-0.5">
                <summary className="cursor-pointer opacity-70">{t("查看网关返回", "Show response")}</summary>
                <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{raw}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
