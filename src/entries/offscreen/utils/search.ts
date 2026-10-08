import axios from "axios";
import { get } from "es-toolkit/compat";
import { createResourceClient } from "~/extends/axios/resourceClient.ts";
import { siteDependencies } from "../adapter/site.ts";
import type { IAdvancedSearchRequestConfig, TSiteID } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IConfigPiniaStorageSchema, TSearchResultSnapshotStorageSchema } from "@/shared/types.ts";
import { SearchQuery } from "~/application/search/query.ts";
import type { HttpClient, Logger, SettingsReader } from "~/domain/ports/index.ts";

import { logger } from "./logger.ts";
import { getSiteInstance } from "./site.ts";
import { publicSearchSnapshot } from "@/shared/security/artifacts.ts";

const searchHttpClient: HttpClient = {
  async request({ resourceId, body, method, path, ...options }) {
    const response = await createResourceClient({ kind: "site", resourceId }).request({
      ...options,
      params: options.params,
      data: body,
      method,
      url: path,
    });
    return {
      data: response.data,
      headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, String(value)])),
      status: response.status,
    };
  },
};

const searchSettings: SettingsReader = {
  async get<T>(key: string): Promise<T | undefined> {
    if (!["config", "metadata"].includes(key)) return undefined;
    return (await sendMessage("getExtStorage", key as "config" | "metadata")) as T;
  },
};

const searchLogger: Logger = {
  debug: (msg, data) => logger({ data, level: "debug", msg }),
  error: (msg, error, data) => logger({ data: { ...data, error: String(error) }, level: "error", msg }),
  info: (msg, data) => logger({ data, level: "info", msg }),
  warn: (msg, data) => logger({ data, level: "warn", msg }),
};

const searchQuery = new SearchQuery({
  http: searchHttpClient,
  logger: searchLogger,
  settings: searchSettings,
  siteFactory: {
    async create(siteId: TSiteID, context) {
      const ports = siteDependencies(siteId);
      ports.http = axios.create({
        adapter: async (config) => {
          const response = await context.http.request({
            resourceId: `site:${siteId}`,
            method: config.method!.toUpperCase() as never,
            path: axios.getUri(config),
            body: config.data,
            headers: config.headers.toJSON() as Record<string, string>,
            responseType: config.responseType as never,
            timeout: config.timeout,
            maxRedirects: config.maxRedirects,
          });
          return { ...response, statusText: "", config, request: {} };
        },
      });
      ports.logger = context.logger;
      ports.settings.read = async <T>(store: string, path: string) => {
        const value = await context.settings.get(store);
        return (path ? get(value, path, null) : value) as T | null;
      };
      ports.settings.retrieve = <T>(id: string, key: string, field = "runtimeSettings") =>
        ports.settings.read<T>("metadata", `sites.${id}.${field}.${key}`);
      return await getSiteInstance<"public">(siteId, { dependencies: ports });
    },
  },
});

onMessage("getSiteSearchResult", async ({ data }) => await searchQuery.execute(data));

async function getSnapshotData() {
  return ((await sendMessage("getExtStorage", "searchResultSnapshot")) ?? {}) as TSearchResultSnapshotStorageSchema;
}

onMessage("getSearchResultSnapshotData", async ({ data: snapshotId }) => {
  const snapshotData = await getSnapshotData();
  return snapshotData?.[snapshotId];
});

onMessage("saveSearchResultSnapshotData", async ({ data: { snapshotId, data } }) => {
  const snapshotData = await getSnapshotData();
  snapshotData[snapshotId] = publicSearchSnapshot(data);
  logger({ msg: `A new SearchResult Snapshot will be add at: ${snapshotId}`, data });
  await sendMessage("setExtStorage", { key: "searchResultSnapshot", value: snapshotData });
});

onMessage("removeSearchResultSnapshotData", async ({ data: snapshotId }) => {
  const snapshotData = await getSnapshotData();
  delete snapshotData[snapshotId];
  await sendMessage("setExtStorage", { key: "searchResultSnapshot", value: snapshotData });
  logger({ msg: `SearchResult Snapshot ${snapshotId} is removed.` });
});
