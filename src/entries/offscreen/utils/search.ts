import axios from "axios";
import type { IAdvancedSearchRequestConfig, TSiteID } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IConfigPiniaStorageSchema, TSearchResultSnapshotStorageSchema } from "@/shared/types.ts";
import { SearchQuery } from "~/application/search/query.ts";
import type { HttpClient, Logger, SettingsReader } from "~/domain/ports/index.ts";

import { logger } from "./logger.ts";
import { getSiteInstance } from "./site.ts";

const legacyHttpClient: HttpClient = {
  async request({ body, method, path }) {
    const response = await axios.request({ data: body, method, url: path });
    return {
      data: response.data,
      headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, String(value)])),
      status: response.status,
    };
  },
};

const legacySettings: SettingsReader = {
  async get<T>(key: string): Promise<T | undefined> {
    if (key !== "config") return undefined;
    return (await sendMessage("getExtStorage", "config")) as T;
  },
};

const legacyLogger: Logger = {
  debug: (msg, data) => logger({ data, level: "debug", msg }),
  error: (msg, error, data) => logger({ data: { ...data, error: String(error) }, level: "error", msg }),
  info: (msg, data) => logger({ data, level: "info", msg }),
  warn: (msg, data) => logger({ data, level: "warn", msg }),
};

const searchQuery = new SearchQuery({
  http: legacyHttpClient,
  logger: legacyLogger,
  settings: legacySettings,
  siteFactory: {
    async create(siteId: TSiteID, _context) {
      return await getSiteInstance<"public">(siteId);
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
  snapshotData[snapshotId] = data;
  logger({ msg: `A new SearchResult Snapshot will be add at: ${snapshotId}`, data });
  await sendMessage("setExtStorage", { key: "searchResultSnapshot", value: snapshotData });
});

onMessage("removeSearchResultSnapshotData", async ({ data: snapshotId }) => {
  const snapshotData = await getSnapshotData();
  delete snapshotData[snapshotId];
  await sendMessage("setExtStorage", { key: "searchResultSnapshot", value: snapshotData });
  logger({ msg: `SearchResult Snapshot ${snapshotId} is removed.` });
});
