/**
 * this plugin is edit from ohmree/pinia-plugin-webext-storage
 *
 * Tauri 迁移：原基于 chrome.storage + onChanged 跨上下文同步，现改为 extStorage（Tauri 持久化）。
 * 单进程模型下不再需要 onChanged 跨上下文同步，已移除。
 */
import type { Ref } from "vue";
import { ref, unref } from "vue";
import { MutationType, PiniaPluginContext } from "pinia";

import { extStorage } from "@/storage.ts";

export class PiniaPersistenceSaveError extends Error {
  readonly code = "PINIA_PERSISTENCE_SAVE_FAILED";
  readonly storageKey: string;

  constructor(storageKey: string, cause: unknown) {
    super(`Failed to save persisted Pinia store "${storageKey}"`, { cause });
    this.name = "PiniaPersistenceSaveError";
    this.storageKey = storageKey;
  }
}

export function isStorageConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === "string") return current.startsWith("STORAGE_CONFLICT");
    if (!current || typeof current !== "object") return false;
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === "STORAGE_CONFLICT") return true;
    current = value.cause;
  }
  return false;
}

export async function persistent<T>(key: string, newValue: T) {
  const value = JSON.parse(JSON.stringify(newValue));
  if (key === "config" || key === "metadata") {
    await extStorage.mergeItem(key, null, value);
  } else {
    await extStorage.setItem(key as never, value as never);
  }
}

export interface restoreOptions<T = any> {
  initialValue?: T | Ref<T>;
  writeDefaults?: boolean;
  onError?: null | ((e: any) => void);
}

export async function restore<T>(key: string, options: restoreOptions<T> = {}): Promise<T> {
  const { initialValue, writeDefaults = true, onError = null } = options;

  const rawInit: T = unref(initialValue)!;

  try {
    console.debug("Restoring state for key:");
    const fromStorage = await extStorage.getItem(key as never);
    if (fromStorage !== null) {
      return fromStorage as T;
    } else {
      if (writeDefaults && rawInit !== null) {
        await persistent(key, rawInit);
      }
      return rawInit;
    }
  } catch (e) {
    onError?.(e);
    throw e;
  }
}

export interface PersistedStateOptions {
  /**
   * Storage key to use.
   * @default $store.id
   */
  key?: string;

  writeDefaultState?: boolean;
  autoSaveType?: boolean | MutationType[];

  /**
   * Hook called before state is hydrated from storage.
   * @default undefined
   */
  beforeRestore?: (context: PiniaPluginContext) => void;

  /**
   * Hook called after state is hydrated from storage.
   * @default undefined
   */
  afterRestore?: (context: PiniaPluginContext) => void;

  onRestoreError?: (e: any) => void;
  onSaveError?: (error: PiniaPersistenceSaveError) => void;
}

declare module "pinia" {
  export interface DefineStoreOptionsBase<S, Store> {
    /**
     * Persist store in storage.
     */
    persistWebExt?: boolean | PersistedStateOptions;
  }

  export interface PiniaCustomProperties {
    readonly $ready: Ref<boolean>;

    $save(): Promise<void>;
    $onReady(callback?: () => void): Promise<void>;
    $adoptCommitted(snapshot: unknown): Promise<boolean>;
  }
}

export function piniaWebExtPersistencePlugin(context: PiniaPluginContext) {
  const {
    options: { persistWebExt },
    store,
  } = context;

  if (!persistWebExt) {
    return {};
  }

  const {
    key = store.$id,
    writeDefaultState = true,
    autoSaveType = false,
    beforeRestore = null,
    afterRestore = null,
    onRestoreError = null,
    onSaveError = null,
  } = typeof persistWebExt !== "boolean" ? persistWebExt : {};

  const $ready = ref(false);
  let committed: unknown = null;
  let saveQueue = Promise.resolve();

  beforeRestore?.(context);
  const restorePromise = restore(key, {
    initialValue: store.$state,
    writeDefaults: writeDefaultState,
    onError: onRestoreError,
  }).then((value) => {
    store.$patch(value as unknown as typeof store.$state);
    committed = JSON.parse(JSON.stringify(value));
    $ready.value = true;
    afterRestore?.(context);
  });

  const $onReady = async (callback?: () => void) => {
    const promise = restorePromise || Promise.resolve();
    await promise;
    callback?.();
  };

  const replaceState = (snapshot: unknown) => {
    store.$patch((state) => {
      for (const field of Object.keys(state)) delete state[field];
      Object.assign(state, JSON.parse(JSON.stringify(snapshot)));
    });
  };

  const $save = async (newState = store.$state) => {
    const proposed = JSON.parse(JSON.stringify(newState));
    const save = saveQueue.then(async () => {
      try {
        if (key === "config" || key === "metadata") {
          const authoritative = await extStorage.mergeItem(key, committed as never, proposed);
          committed = JSON.parse(JSON.stringify(authoritative));
          if (JSON.stringify(store.$state) === JSON.stringify(proposed)) {
            replaceState(authoritative);
          }
        } else {
          await persistent(key, proposed);
          committed = proposed;
        }
      } catch (error) {
        if (key === "config" || key === "metadata") {
          if (isStorageConflict(error)) {
            try {
              const latest = await extStorage.getItem(key);
              if (latest !== null) committed = JSON.parse(JSON.stringify(latest));
            } catch {
              // Keep the last committed snapshot when the follow-up read fails.
            }
          }
        }
        if (JSON.stringify(store.$state) === JSON.stringify(proposed) && committed) {
          replaceState(committed);
        }
        const saveError = new PiniaPersistenceSaveError(key, error);
        try {
          onSaveError?.(saveError);
        } catch {
          console.error('[pinia] Failed to report save error for store ""');
        }
        throw saveError;
      }
    });
    saveQueue = save.catch(() => undefined);
    await save;
  };

  const $adoptCommitted = async (snapshot: unknown): Promise<boolean> => {
    await $onReady();
    await saveQueue;
    if (JSON.stringify(store.$state) !== JSON.stringify(committed)) return false;
    committed = JSON.parse(JSON.stringify(snapshot));
    replaceState(committed);
    return true;
  };

  const reportAutoSaveError = (error: unknown) => {
    const saveError = error instanceof PiniaPersistenceSaveError ? error : new PiniaPersistenceSaveError(key, error);
    if (!onSaveError) console.error('[pinia] Failed to automatically save store ""');
  };

  if (autoSaveType && Array.isArray(autoSaveType)) {
    store.$subscribe((mutation, state: any) => {
      if (autoSaveType.includes(mutation.type)) {
        void $save(state).catch(reportAutoSaveError);
      }
    });
  }

  const originalDispose = store.$dispose;
  const $dispose = () => {
    originalDispose.call(store);
  };

  return { $dispose, $save, $ready, $onReady, $adoptCommitted };
}
