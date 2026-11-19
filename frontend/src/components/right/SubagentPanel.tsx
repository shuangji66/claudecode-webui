import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/runtime";
import { applyCLI } from "../../lib/normalize";
import type { Item } from "../../lib/model";
import type { SubagentTranscriptPayload } from "../../transport/types";
import { MessageList } from "../chat/MessageList";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../store/useAppStore";

/**
 * 一个子代理的对话。
 *
 * 数据来自旁路转录（`<session>/subagents/agent-<id>.jsonl`）：主转录里没有 sidechain
 * 行，所以不能靠回放主对话得到子代理说过什么。
 */
export function SubagentPanel({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [meta, setMeta] = useState<SubagentTranscriptPayload["meta"]>(undefined);
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  // 实时帧（--forward-subagent-text）优先：转录是落盘快照，会比界面慢一拍。
  const live = useAppStore((s) => s.subagentItems[sessionId]?.[agentId]);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setItems([]);
    setMeta(undefined);
    void (async () => {
      try {
        const tr = await apiFetch<SubagentTranscriptPayload>(
          `/api/history/subagent?id=${encodeURIComponent(sessionId)}&agent=${encodeURIComponent(agentId)}`,
        );
        let next: Item[] = [];
        for (const line of tr.lines ?? []) {
          const rec = line as { timestamp?: unknown };
          const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
          // 同样是转录回放：关掉「CLI 回显去重」（子代理转录里也没有本地乐观气泡，
          // 每一条 user 行都是真的发过的）。
          next = applyCLI(next, line, Number.isFinite(at) ? at : Date.now(), undefined, { replay: true });
        }
        if (!alive) return;
        setMeta(tr.meta);
        setItems(next);
        setState("ok");
      } catch {
        // 子代理转录可能已被 claude 清理，或这台机器上没有那份文件。
        if (alive) setState("missing");
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, agentId]);

  if (state === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted">
        {t("正在加载子代理对话…", "Loading subagent chat…")}
      </div>
    );
  }
  if (state === "missing") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[12.5px] font-medium text-ink">{t("没有可显示的对话", "No transcript")}</p>
        <p className="text-[11px] leading-relaxed text-muted">
          {t("这个子代理的转录不在磁盘上（可能已被 claude 清理）。", "This subagent transcript is not on disk anymore.")}
        </p>
      </div>
    );
  }

  const subtitle = [
    meta?.agentType,
    typeof meta?.spawnDepth === "number" ? t(`深度 ${meta.spawnDepth}`, `depth ${meta.spawnDepth}`) : undefined,
    meta?.finished ? t("已结束", "finished") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line px-3 py-2">
        <p className="truncate text-[12px] font-medium text-ink">{meta?.description || agentId}</p>
        <p className="mt-0.5 truncate text-[10.5px] text-muted">{subtitle || agentId}</p>
      </div>
      <div className="min-h-0 flex-1">
        <MessageList
          items={live && live.length > 0 ? live : items}
          empty={t("子代理还没有输出", "No output from this subagent yet")}
        />
      </div>
    </div>
  );
}
