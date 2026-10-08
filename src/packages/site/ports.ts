import type { AxiosInstance } from "axios";
import type { Logger } from "~/domain/ports/index.ts";
import type { ISiteUserConfig } from "./types.ts";

export interface SiteDependencies {
  http: AxiosInstance;
  settings: {
    store(siteId: string, key: string, value: unknown, field?: keyof ISiteUserConfig): Promise<void>;
    retrieve<T>(siteId: string, key: string, field?: keyof ISiteUserConfig): Promise<T | null>;
    read<T>(store: string, keyPath: string): Promise<T | null>;
  };
  clock: { now(): number; sleep(ms: number): Promise<void> };
  logger: Logger;
}
