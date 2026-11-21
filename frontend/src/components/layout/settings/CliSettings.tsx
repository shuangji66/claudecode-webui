import { useEffect, useState } from "react";
import { useAppStore } from "../../../store/useAppStore";
import { useT } from "../../../lib/i18n";
import { Select } from "../../common/Select";
import { SettingRow, SettingRows } from "./Section";

/** 空闲回收的步进与范围（分钟），与后端 settings.Min/Max/StepIdleMinutes 对齐。 */
const IDLE_MIN = 5;
const IDLE_MAX = 60;
const IDLE_STEP = 5;

/** 并发子代理的范围，与后端 settings.Min/MaxSubagentMaxConcurrent 对齐。 */
const CONCURRENT_MIN = 1;
const CONCURRENT_MAX = 50;
/** 递归深度 1–5：1 = 关闭嵌套，5 是 CLI 2.1.172–2.1.216 时期的原生默认。 */
const DEPTH_OPTIONS = [1, 2, 3, 4, 5];

/** 把配置里的实际值并进候选档位，避免手改出来的值在下拉里显示成空。 */
function withCurrent(options: number[], current: number): number[] {
  if (options.includes(current)) return options;
  return [...options, current].sort((a, b) => a - b);
}

/**
 * 「设置 → CLI」：直接映射成 claude 子进程环境变量的几项。
 *
 * 这一页的值都在**进程启动时**读取（`settings.Env()` → `process.CleanEnv` 后追加），
 * 没有控制请求、也没有命令行参数，所以改完只对新建会话生效——已跑着的会话保持
 * 启动时的那份。界面上的说明必须讲清楚这一点，否则「改了没反应」会被当成 bug。
 */
export function CliSettings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const saving = useAppStore((s) => s.settingsSaving);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = async (patch: Parameters<typeof saveSettings>[0]) => {
    const ok = await saveSettings(patch);
    if (ok) setSavedAt(Date.now());
    return ok;
  };

  const concurrent = settings?.subagent_max_concurrent || 10;
  const depth = settings?.subagent_spawn_depth || 1;

  /**
   * 并发上限是输入框（范围 1–50，档位式下拉要连点几十次才能从 10 走到 50）。
   * 输入期间只做「只留数字」，**不在按键时夹范围**——打「5」想接「0」时会被夹成
   * 「5」再变「50」就跳字了；范围在失焦 / 回车时夹，成不了合法值就回填权威值。
   */
  const [concurrentDraft, setConcurrentDraft] = useState(String(concurrent));
  // 权威值变了要跟上（保存回来后端回的新值、或别处改了设置）。
  useEffect(() => {
    setConcurrentDraft(String(concurrent));
  }, [concurrent]);

  const commitConcurrent = () => {
    const digits = concurrentDraft.replace(/[^\d]/g, "");
    if (digits === "") {
      setConcurrentDraft(String(concurrent));
      return;
    }
    const next = Math.min(CONCURRENT_MAX, Math.max(CONCURRENT_MIN, Number(digits)));
    setConcurrentDraft(String(next));
    if (next === concurrent) return;
    void save({ subagent_max_concurrent: next }).then((ok) => {
      // 保存失败时 store 里的值没变，用户看到的必须是真实生效的那个数。
      if (!ok) setConcurrentDraft(String(concurrent));
    });
  };

  // 空闲回收同样按本地递进值算，连点两次不会都从同一个旧值起步。
  // 步进 5 分钟（5–60 共 12 档）：一分钟一档要点十几次才从默认值挪到半小时，
  // 而这个值本来就是粗粒度的时间尺度，不需要那个精度。
  const idleMinutes = settings?.idle_minutes || 10;
  const [pendingIdle, setPendingIdle] = useState<number | null>(null);
  const shownIdle = pendingIdle ?? idleMinutes;
  /**
   * 每次按键挪一档。**在 5 的整数倍上算档位**，而不是 `shownIdle + delta`：
   * 配置文件被手改成 7 这类不在档位上的值时，加一次要落到 10 而不是 12。
   */
  const bumpIdle = (delta: number) => {
    const index = Math.round(shownIdle / IDLE_STEP) + delta;
    const next = Math.min(IDLE_MAX, Math.max(IDLE_MIN, index * IDLE_STEP));
    if (next === shownIdle) return;
    setPendingIdle(next);
    void save({ idle_minutes: next }).then(() => setPendingIdle(null));
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{t("CLI 设置", "CLI")}</h3>
        {(saving || savedAt) && (
          <span className="ml-auto text-[10.5px] text-faint">
            {saving ? t("保存中…", "Saving…") : t("已保存", "Saved")}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {t(
          "这些值以环境变量的形式交给 claude 子进程，只在会话启动时读取：改完对新建的会话生效，已经在跑的会话保持原样。",
          "These are passed to the claude subprocess as environment variables, read only at session start: changes apply to new sessions.",
        )}
      </p>

      <SettingRows>
        <SettingRow
          title={t("并发子代理", "Concurrent subagents")}
          desc={t(
            `同一时刻最多同时运行多少个子代理（${CONCURRENT_MIN}–${CONCURRENT_MAX}）；到上限后模型再派生子代理会被拒绝。`,
            `How many subagents may run at once (${CONCURRENT_MIN}–${CONCURRENT_MAX}); spawning past the cap is rejected.`,
          )}
        >
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={concurrentDraft}
            // 只留数字：字母、符号、空格直接吞掉，粘贴「10 个」也只会落下 10。
            onChange={(e) => setConcurrentDraft(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={commitConcurrent}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label={t("并发子代理", "Concurrent subagents")}
            className="w-20 rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-center font-mono text-[12px] text-ink outline-none focus:border-brand/60"
          />
        </SettingRow>

        <SettingRow
          title={t("子代理递归深度", "Subagent nesting depth")}
          desc={t(
            "主对话之下允许嵌套几层子代理；1 表示关闭嵌套（子代理自己不能再派子代理）。",
            "How many subagent layers may nest below the main conversation; 1 turns nesting off.",
          )}
        >
          <Select
            variant="pill"
            ariaLabel={t("子代理递归深度", "Subagent nesting depth")}
            value={String(depth)}
            onChange={(next) => void save({ subagent_spawn_depth: Number(next) })}
            options={withCurrent(DEPTH_OPTIONS, depth).map((n) => ({
              value: String(n),
              label: n === 1 ? t("1 层（不嵌套）", "1 layer (off)") : t(`${n} 层`, `${n} layers`),
            }))}
            menuWidth={168}
          />
        </SettingRow>

        <SettingRow
          title={t("空闲回收", "Idle recycle")}
          desc={t("会话闲置这么久了就结束进程，下次打开会重新接上。", "End the process after this much idle time; reopening reconnects it.")}
        >
          <div className="flex items-center gap-1.5">
            <div className="inline-flex items-center rounded-lg bg-panel dark:bg-panel-strong">
              <button
                type="button"
                onClick={() => bumpIdle(-1)}
                disabled={shownIdle <= IDLE_MIN}
                className="h-8 w-8 rounded-l-lg text-[13px] text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-30 dark:hover:bg-line disabled:hover:bg-transparent"
                aria-label={t("缩短空闲回收", "Decrease idle timeout")}
              >
                −
              </button>
              <span className="w-8 text-center font-mono text-[12.5px] text-ink tabular-nums">{shownIdle}</span>
              <button
                type="button"
                onClick={() => bumpIdle(1)}
                disabled={shownIdle >= IDLE_MAX}
                className="h-8 w-8 rounded-r-lg text-[13px] text-muted hover:bg-panel-strong hover:text-ink disabled:opacity-30 dark:hover:bg-line disabled:hover:bg-transparent"
                aria-label={t("延长空闲回收", "Increase idle timeout")}
              >
                +
              </button>
            </div>
            <span className="text-[11.5px] text-muted">{t("分钟", "min")}</span>
          </div>
        </SettingRow>
      </SettingRows>
    </div>
  );
}
