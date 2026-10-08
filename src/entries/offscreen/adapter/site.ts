import { get, set } from "es-toolkit/compat";
import type { SiteDependencies, ISiteUserConfig } from "@ptd/site";
import { createResourceClient } from "~/extends/axios/resourceClient.ts";
import { extStorage } from "@/storage.ts";
import { logger } from "../utils/logger.ts";

export function siteDependencies(siteId: string): SiteDependencies {
  return {
    http: createResourceClient({ kind: "site", resourceId: `site:${siteId}` }),
    settings: {
      async store(id, key, value, field: keyof ISiteUserConfig = "runtimeSettings") {
        const base = await extStorage.getItem("metadata");
        if (!base?.sites?.[id]) throw new Error("SITE_NOT_CONFIGURED");
        const proposed = structuredClone(base);
        set(proposed.sites[id], [field, key], value);
        await extStorage.mergeItem("metadata", base, proposed);
      },
      async retrieve<T>(id: string, key: string, field: keyof ISiteUserConfig = "runtimeSettings") {
        return get(await extStorage.getItem("metadata"), ["sites", id, field, key], null) as T | null;
      },
      async read<T>(store: string, keyPath: string) {
        const value = await extStorage.getItem(store as never);
        return (keyPath ? get(value, keyPath, null) : value) as T | null;
      },
    },
    clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    logger: {
      debug: (msg) => {
        logger({ msg });
      },
      info: (msg) => {
        logger({ msg });
      },
      warn: (msg) => {
        logger({ msg, level: "warn" });
      },
      error: (msg) => {
        logger({ msg, level: "error" });
      },
    },
  };
}
