import type { Pinia } from "pinia";
import { invokeIpc } from "~/extends/tauri/ipc.ts";
import type { IConfigPiniaStorageSchema, IMetadataPiniaStorageSchema } from "@/shared/types.ts";
import { useConfigStore } from "../stores/config.ts";
import { useMetadataStore } from "../stores/metadata.ts";

interface CacheSnapshot {
  revision: number;
  config: IConfigPiniaStorageSchema | null;
  metadata: IMetadataPiniaStorageSchema | null;
}

let appliedRevision = -1;
let refreshQueue = Promise.resolve();

export function refreshResourceCache(pinia: Pinia, force = false): Promise<void> {
  const refresh = refreshQueue.then(async () => {
    const snapshot = (await invokeIpc("get_cache_snapshot", {})) as CacheSnapshot;
    if (!force && snapshot.revision <= appliedRevision) return;
    const config = useConfigStore(pinia);
    const metadata = useMetadataStore(pinia);
    await Promise.all([config.$onReady(), metadata.$onReady()]);
    const accepted = await Promise.all([
      snapshot.config ? config.$adoptCommitted(snapshot.config) : true,
      snapshot.metadata ? metadata.$adoptCommitted(snapshot.metadata) : true,
    ]);
    if (accepted.every(Boolean)) appliedRevision = snapshot.revision;
  });
  refreshQueue = refresh.catch(() => undefined);
  return refresh;
}

export function startResourceCacheSync(pinia: Pinia): () => void {
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    void refreshResourceCache(pinia).catch(() => console.error("[cache] Failed to refresh persisted resources"));
  };
  const onVisibility = () => {
    if (!document.hidden) refresh();
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", onVisibility);
  const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("ptd-resources");
  if (channel) channel.onmessage = refresh;
  return () => {
    stopped = true;
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", onVisibility);
    channel?.close();
  };
}
