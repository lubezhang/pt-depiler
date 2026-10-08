import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { createPinia, defineStore, MutationType, type Pinia, type Store } from "pinia";

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  mergeItem: vi.fn(),
}));

vi.mock("@/storage.ts", () => ({ extStorage: storage }));

import {
  PiniaPersistenceSaveError,
  isStorageConflict,
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
  storage.mergeItem.mockReset().mockImplementation(async (_key, _base, value) => value);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pinia Tauri 持久化", () => {
  it("失败回滚删除未提交根字段，显式保存也触发反馈", async () => {
    const onSaveError = vi.fn();
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    const { store } = createTestStore({ onSaveError });
    await store.$onReady();
    store.$patch({ theme: "dark", draft: { token: "SENSITIVE_DRAFT" } } as never);
    storage.mergeItem.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.$save()).rejects.toBeInstanceOf(PiniaPersistenceSaveError);
    expect(store.theme).toBe("light");
    expect(store.$state).not.toHaveProperty("draft");
    expect(onSaveError).toHaveBeenCalledOnce();
  });
  it("通过真实 Pinia 插件流程恢复已存储状态", async () => {
    storage.getItem.mockResolvedValueOnce({ theme: "dark" });
    const { store } = createTestStore();

    await store.$onReady();

    expect(store.theme).toBe("dark");
    expect(store.$ready).toBe(true);
  });

  it("恢复失败时保留初始状态并阻断启动", async () => {
    const restoreError = new Error("store unavailable");
    const onRestoreError = vi.fn();
    storage.getItem.mockRejectedValueOnce(restoreError);
    const { store } = createTestStore({ onRestoreError, writeDefaultState: false });

    await expect(store.$onReady()).rejects.toBe(restoreError);

    expect(store.theme).toBe("light");
    expect(onRestoreError).toHaveBeenCalledWith(restoreError);
  });

  it("保留非 null 的假值存储结果", async () => {
    storage.getItem.mockResolvedValueOnce(false);

    await expect(restore<boolean>("featureEnabled", { initialValue: true, writeDefaults: false })).resolves.toBe(false);
  });

  it("$save 携旧快照条件提交当前状态", async () => {
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    const { store } = createTestStore();
    await store.$onReady();
    store.theme = "dark";

    await store.$save();

    expect(storage.mergeItem).toHaveBeenCalledWith("config", { theme: "light" }, { theme: "dark" });
  });

  it("$save 将 Tauri Store 写入失败暴露为结构化错误", async () => {
    const writeError = new Error("disk unavailable");
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    const { store } = createTestStore();
    await store.$onReady();
    storage.mergeItem.mockRejectedValueOnce(writeError);

    const saveError = await store.$save().catch((error: unknown) => error);

    expect(saveError).toBeInstanceOf(PiniaPersistenceSaveError);
    expect(saveError).toMatchObject({
      cause: writeError,
      code: "PINIA_PERSISTENCE_SAVE_FAILED",
      name: "PiniaPersistenceSaveError",
      storageKey: "config",
    });
  });

  it("同字段冲突时重读权威值并允许用户在最新值上重试", async () => {
    storage.getItem.mockResolvedValueOnce({ theme: "light" }).mockResolvedValueOnce({ theme: "remote" });
    storage.mergeItem.mockRejectedValueOnce("STORAGE_CONFLICT:merge_ext_storage");
    const { store } = createTestStore();
    await store.$onReady();
    store.theme = "local";

    const error = await store.$save().catch((cause: unknown) => cause);

    expect(isStorageConflict(error)).toBe(true);
    expect(store.theme).toBe("remote");
    store.theme = "revised";
    await store.$save();
    expect(storage.mergeItem).toHaveBeenLastCalledWith("config", { theme: "remote" }, { theme: "revised" });
  });

  it("自动保存失败时调用 onSaveError", async () => {
    const writeError = new Error("disk unavailable");
    const onSaveError = vi.fn();
    storage.getItem.mockResolvedValueOnce({ theme: "light" });
    storage.mergeItem.mockRejectedValueOnce(writeError);
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
      storage.mergeItem.mockRejectedValueOnce(writeError);
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
