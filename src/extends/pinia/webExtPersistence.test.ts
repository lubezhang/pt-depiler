import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { createPinia, defineStore, MutationType, type Pinia, type Store } from "pinia";

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock("@/storage.ts", () => ({ extStorage: storage }));

import {
  PiniaPersistenceSaveError,
  piniaWebExtPersistencePlugin,
  restore,
  type PersistedStateOptions,
} from "./webExtPersistence.ts";

type TestStore = Store<"test-persistence", { theme: string }, {}, {}>;

function createTestStore(options: PersistedStateOptions = {}): { pinia: Pinia; store: TestStore } {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  app.use(pinia);

  const useTestStore = defineStore("test-persistence", {
    persistWebExt: { key: "config", ...options },
    state: () => ({ theme: "light" }),
  });

  return { pinia, store: useTestStore(pinia) };
}

beforeEach(() => {
  storage.getItem.mockReset();
  storage.setItem.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pinia Tauri 持久化", () => {
  it("通过真实 Pinia 插件流程恢复已存储状态", async () => {
    storage.getItem.mockResolvedValueOnce({ theme: "dark" });
    const { store } = createTestStore();

    await store.$onReady();

    expect(store.theme).toBe("dark");
    expect(store.$ready).toBe(true);
  });

  it("恢复失败时保留初始状态并将原始错误传给 onRestoreError", async () => {
    const restoreError = new Error("store unavailable");
    const onRestoreError = vi.fn();
    storage.getItem.mockRejectedValueOnce(restoreError);
    const { store } = createTestStore({ onRestoreError, writeDefaultState: false });

    await store.$onReady();

    expect(store.theme).toBe("light");
    expect(onRestoreError).toHaveBeenCalledWith(restoreError);
  });

  it("保留非 null 的假值存储结果", async () => {
    storage.getItem.mockResolvedValueOnce(false);

    await expect(restore<boolean>("featureEnabled", { initialValue: true, writeDefaults: false })).resolves.toBe(false);
  });

  it("$save 将当前状态写入 Tauri Store", async () => {
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    const { store } = createTestStore();
    await store.$onReady();
    store.theme = "dark";

    await store.$save();

    expect(storage.setItem).toHaveBeenCalledWith("config", { theme: "dark" });
  });

  it("$save 将 Tauri Store 写入失败暴露为结构化错误", async () => {
    const writeError = new Error("disk unavailable");
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    const { store } = createTestStore();
    await store.$onReady();
    storage.setItem.mockRejectedValueOnce(writeError);

    const saveError = await store.$save().catch((error: unknown) => error);

    expect(saveError).toBeInstanceOf(PiniaPersistenceSaveError);
    expect(saveError).toMatchObject({
      cause: writeError,
      code: "PINIA_PERSISTENCE_SAVE_FAILED",
      name: "PiniaPersistenceSaveError",
      storageKey: "config",
    });
  });

  it("自动保存失败时调用 onSaveError", async () => {
    const writeError = new Error("disk unavailable");
    const onSaveError = vi.fn();
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    storage.setItem.mockRejectedValueOnce(writeError);
    const { store } = createTestStore({ autoSaveType: [MutationType.direct], onSaveError });
    await store.$onReady();

    store.theme = "dark";

    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalledOnce());
    expect(onSaveError).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: writeError,
        code: "PINIA_PERSISTENCE_SAVE_FAILED",
        storageKey: "config",
      }),
    );
  });

  it("自动保存失败没有 hook 时记录错误且不产生未处理 rejection", async () => {
    const writeError = new Error("disk unavailable");
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      storage.getItem.mockResolvedValueOnce({ theme: "light" });
      storage.setItem.mockRejectedValueOnce(writeError);
      const { store } = createTestStore({ autoSaveType: [MutationType.direct] });
      await store.$onReady();

      store.theme = "dark";

      await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("注入后的 $dispose 仅调用一次原始释放并从 Pinia 注册表移除", async () => {
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    const { pinia, store } = createTestStore();
    const storeRegistry = (pinia as unknown as { _s: Map<string, unknown> })._s;
    const deleteStore = vi.spyOn(storeRegistry, "delete");

    expect(() => store.$dispose()).not.toThrow();

    expect(deleteStore).toHaveBeenCalledTimes(1);
    expect(storeRegistry.has(store.$id)).toBe(false);
  });
});
