import type { DownloaderDependencies } from "@ptd/downloader";
import { createResourceClient } from "~/extends/axios/resourceClient.ts";
export function downloaderDependencies(id?: string): DownloaderDependencies {
  return {
    http: createResourceClient({ kind: "service", resourceId: id ? `downloader:${id}` : "downloader:legacy" }),
    torrentHttp: createResourceClient({ kind: "site", resourceId: "site:legacy" }),
    openWebSocket: (url) => new WebSocket(url),
  };
}
