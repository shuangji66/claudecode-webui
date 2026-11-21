import { useAppStore } from "../../store/useAppStore";

/**
 * 轻提示（toast）：只报一句话，`store.showToast` 弹、几秒后自己消失。
 *
 * 与顶部那条错误提示分开：错误要用户处理（带关闭键、不会自动收），
 * 而「已归档的对话先取消归档」这类说明看完就过去了。
 * 整块 `pointer-events-none`：它浮在输入框上方，绝不能挡住点按。
 */
export function Toast() {
  const toast = useAppStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] z-[46] flex justify-center px-3 md:bottom-6">
      <div
        role="status"
        aria-live="polite"
        className="max-w-[min(560px,100%)] animate-rise rounded-xl bg-ink px-3.5 py-2 text-[12px] leading-relaxed text-canvas shadow-xl"
      >
        {toast.text}
      </div>
    </div>
  );
}
