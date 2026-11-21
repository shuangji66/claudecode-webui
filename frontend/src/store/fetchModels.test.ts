// 「获取可用模型」的并发：目录是全局单份（modelsFor + gatewayModels），
// 两张提供商卡片先后点「获取」时，先发的那次晚回来会顶掉后一次的目录——
// 弹窗里摆着 A 的模型，确认后却写进 B，用户看到的是「加了几个不存在的模型」。
// 与单模型验证的 verifySeq 同一条规矩。
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Defer {
  form: { uid: string; id: string };
  resolve: (r: unknown) => void;
}

const pending: Defer[] = [];

vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return {
    ...actual,
    apiFetch: vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((resolve) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          pending.push({ form: { uid: body.provider_id, id: body.provider_id }, resolve });
        }),
    ),
  };
});

const { useAppStore } = await import("./useAppStore");

function form(uid: string) {
  return {
    uid,
    id: uid,
    name: uid,
    baseUrl: "",
    apiKey: "",
    auth: "x-api-key",
    clearKey: false,
    modelsPath: "",
    models: [],
    modelMeta: {},
  } as never;
}

describe("fetchModelsFor 只认最后一次请求", () => {
  beforeEach(() => {
    pending.length = 0;
    useAppStore.setState({ modelsFor: "", modelsLoading: false, gatewayModels: [], modelsError: null, modelsRaw: "", modelsAttempts: [] });
  });

  it("先发的 A 晚回来时不覆盖后发的 B 的目录与归属", async () => {
    const a = useAppStore.getState().fetchModelsFor(form("a"));
    expect(useAppStore.getState().modelsFor).toBe("a");
    expect(useAppStore.getState().modelsLoading).toBe(true);

    const b = useAppStore.getState().fetchModelsFor(form("b"));
    expect(useAppStore.getState().modelsFor).toBe("b");

    // B 先回：目录与归属都是 B。
    pending[1].resolve({ models: [{ id: "b-model" }], attempts: [] });
    await b;
    expect(useAppStore.getState().modelsFor).toBe("b");
    expect(useAppStore.getState().gatewayModels.map((m) => m.id)).toEqual(["b-model"]);
    expect(useAppStore.getState().modelsLoading).toBe(false);

    // A 迟到：必须整条丢弃，B 的目录与「在飞」状态都不能被改。
    pending[0].resolve({ models: [{ id: "a-model" }], attempts: [] });
    await a;
    expect(useAppStore.getState().modelsFor).toBe("b");
    expect(useAppStore.getState().gatewayModels.map((m) => m.id)).toEqual(["b-model"]);
    expect(useAppStore.getState().modelsLoading).toBe(false);
  });

  it("先发的 A 迟到失败时，不把 B 的目录清空、也不留错误", async () => {
    const a = useAppStore.getState().fetchModelsFor(form("a"));
    const b = useAppStore.getState().fetchModelsFor(form("b"));
    pending[1].resolve({ models: [{ id: "b-model" }], attempts: [] });
    await b;

    // 让 A 的 apiFetch 走 reject 路径：把它的 resolve 换成抛错。
    pending[0].resolve(Promise.reject(new Error("网关超时")));
    await a.catch(() => undefined);

    expect(useAppStore.getState().modelsFor).toBe("b");
    expect(useAppStore.getState().gatewayModels.map((m) => m.id)).toEqual(["b-model"]);
    expect(useAppStore.getState().modelsError).toBeNull();
  });
});
