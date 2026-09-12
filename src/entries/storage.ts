import { invoke } from "@tauri-apps/api/core";

import {
  IConfigPiniaStorageSchema,
  IMetadataPiniaStorageSchema,
  TUserInfoStorageSchema,
  TSearchResultSnapshotStorageSchema,
  TKeepUploadTaskStorageSchema,
} from "@/shared/types.ts";

export interface IExtensionStorageSchema {
  // 既可以被 pinia 使用，也可以被其他地方使用
  config: IConfigPiniaStorageSchema;

  metadata: IMetadataPiniaStorageSchema;

  userInfo: TUserInfoStorageSchema; // 用于存储用户信息
  searchResultSnapshot: TSearchResultSnapshotStorageSchema; // 用于存储搜索结果快照
  keepUploadTask: TKeepUploadTaskStorageSchema; // 用于存储辅种任务
}

export type TExtensionStorageKey = keyof IExtensionStorageSchema;

/**
 * Tauri 环境下的持久化存储，通过 Rust 命令 get/set_ext_storage 读写（底层 tauri-plugin-store）。
 * 替代原 chrome.storage.local + @webext-core/storage。
 * getItem/setItem 为异步；原 @webext-core/storage 的 reactive 同步缓存语义不再保留，
 * 调用方均已使用 await（见 pinia 持久化与各业务处）。
 */
export const extStorage = {
  async getItem<K extends TExtensionStorageKey>(key: K): Promise<IExtensionStorageSchema[K] | null> {
    const value = await invoke<unknown>("get_ext_storage", { key });
    return value === null || value === undefined ? null : (value as IExtensionStorageSchema[K]);
  },
  async setItem<K extends TExtensionStorageKey>(key: K, value: IExtensionStorageSchema[K]): Promise<void> {
    await invoke("set_ext_storage", { key, value });
  },
};
