import { invokeIpc } from "~/extends/tauri/ipc.ts";

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

type RootKey = "config" | "metadata";
type StorageBaselines = { [K in TExtensionStorageKey]?: IExtensionStorageSchema[K] | null };
const rootKeys = new Set<TExtensionStorageKey>(["config", "metadata"]);
const readBases = new WeakMap<object, unknown>();
const metadataListeners = new Set<(metadata: IMetadataPiniaStorageSchema) => void>();

export function subscribeMetadataCommits(listener: (metadata: IMetadataPiniaStorageSchema) => void): () => void {
  metadataListeners.add(listener);
  return () => metadataListeners.delete(listener);
}

function committedMetadata(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const listener of metadataListeners) listener(value as IMetadataPiniaStorageSchema);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export const extStorage = {
  async mergeBatch(
    base: StorageBaselines,
    value: Partial<IExtensionStorageSchema>,
  ): Promise<Partial<IExtensionStorageSchema>> {
    const result = (await invokeIpc("merge_ext_storage_batch", {
      base: copy(base),
      value: copy(value),
    })) as Partial<IExtensionStorageSchema>;
    committedMetadata(result.metadata);
    return result;
  },
  async getItem<K extends TExtensionStorageKey>(key: K): Promise<IExtensionStorageSchema[K] | null> {
    const value = await invokeIpc("get_ext_storage", { key });
    if (value === null || value === undefined) return null;
    if (rootKeys.has(key) && typeof value === "object") readBases.set(value, copy(value));
    return value as IExtensionStorageSchema[K];
  },
  async mergeItem<K extends RootKey>(
    key: K,
    base: IExtensionStorageSchema[K] | null,
    value: IExtensionStorageSchema[K],
  ): Promise<IExtensionStorageSchema[K]> {
    const result = (await invokeIpc("merge_ext_storage", {
      key,
      base: copy(base),
      value: copy(value),
    })) as IExtensionStorageSchema[K];
    if (key === "metadata") committedMetadata(result);
    return result;
  },
  async setItem<K extends TExtensionStorageKey>(key: K, value: IExtensionStorageSchema[K]): Promise<void> {
    if (rootKeys.has(key)) {
      if (typeof value !== "object" || value === null || !readBases.has(value)) {
        throw new Error("STORAGE_CONDITIONAL_WRITE_REQUIRED:setItem");
      }
      const base = readBases.get(value);
      const committed = (await invokeIpc("merge_ext_storage", {
        key,
        base,
        value: copy(value),
      })) as IExtensionStorageSchema[K];
      for (const field of Object.keys(value)) delete (value as Record<string, unknown>)[field];
      Object.assign(value, committed);
      readBases.set(value, copy(committed));
      if (key === "metadata") committedMetadata(committed);
      return;
    }
    await invokeIpc("set_ext_storage", { key, value });
  },
};
