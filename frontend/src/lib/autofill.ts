// 全局禁用浏览器 / 密码管理器的自动填充。
//
// 这个应用里的地址、密钥、模型 ID 都是「配置项」，不是登录表单。浏览器把 API 地址
// 当成用户名、把 API 密钥当成密码，会弹出「保存/填充密码」浮层（飞牛桌面 iframe 里
// 尤其突兀）。没有统一的 Input 组件，所以用一次 MutationObserver 给所有
// input/textarea 补属性；动态插入的输入框也会被处理。
//
// 密码框必须用 new-password：Chrome/Edge 对 password 字段会忽略 autocomplete=off，
// 只有 new-password 能可靠抑制「保存密码」提示。

const AUTOFILL_ATTRS: ReadonlyArray<[string, string]> = [
  ["data-lpignore", "true"],
  ["data-1p-ignore", "true"],
  ["data-bwignore", "true"],
  ["data-form-type", "other"],
];

function guardElement(el: HTMLInputElement | HTMLTextAreaElement): void {
  const password = el instanceof HTMLInputElement && el.type === "password";
  el.setAttribute("autocomplete", password ? "new-password" : "off");
  for (const [name, value] of AUTOFILL_ATTRS) el.setAttribute(name, value);
}

/** 给 root 下现有的输入框补属性（纯 DOM 操作，可在测试里直接调用）。 */
export function guardAutofill(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
    guardElement(el);
  }
}

/**
 * 安装全局守卫：立即处理现有输入框，并监听之后插入的节点。
 * @returns 取消监听的函数。
 */
export function installAutofillGuard(doc: Document = document): () => void {
  guardAutofill(doc);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("input, textarea")) {
          guardElement(node as HTMLInputElement | HTMLTextAreaElement);
        }
        guardAutofill(node);
      }
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}
