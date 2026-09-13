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

export async function persistent<T>(key: string, newValue: T) {
  await extStorage.setItem(key as never, JSON.parse(JSON.stringify(newValue)) as never);
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
    console.debug("Restoring state for key:", key);
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
    return rawInit;
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

  beforeRestore?.(context);
  let restorePromise = restore(key, {
    initialValue: store.$state,
    writeDefaults: writeDefaultState,
    onError: onRestoreError,
  }).then((value) => {
    store.$patch(value as unknown as typeof store.$state);
    $ready.value = true;
    afterRestore?.(context);
  });

  const $onReady = async (callback?: () => void) => {
    const promise = restorePromise || Promise.resolve();
    if (callback) {
      promise.then(callback);
    }
    return promise;
  };

  const $save = async (newState = store.$state) => {
    try {
      await persistent(key, newState);
    } catch (error) {
      throw new PiniaPersistenceSaveError(key, error);
    }
  };

  const reportAutoSaveError = (error: unknown) => {
    const saveError = error instanceof PiniaPersistenceSaveError ? error : new PiniaPersistenceSaveError(key, error);
    if (onSaveError) {
      try {
        onSaveError(saveError);
      } catch (hookError) {
        console.error(`[pinia] Failed to report automatic save error for store "${store.$id}"`, hookError);
      }
    } else {
      console.error(`[pinia] Failed to automatically save store "${store.$id}"`, saveError);
    }
  };

  if (autoSaveType && Array.isArray(autoSaveType)) {
    store.$subscribe((mutation, state: any) => {
      console?.log("Store `" + store.$id + "` change subscribed: ", mutation);
      if (autoSaveType.includes(mutation.type)) {
        void $save(state).catch(reportAutoSaveError);
      }
    });
  }

  const originalDispose = store.$dispose;
  const $dispose = () => {
    originalDispose.call(store);
  };

  return { $dispose, $save, $ready, $onReady };
}
