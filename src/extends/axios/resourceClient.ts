import axios, { type AxiosInstance } from "axios";

import { createTauriAdapter, type HttpResourceIdentity } from "./tauriAdapter.ts";

export function createResourceClient(identity: HttpResourceIdentity): AxiosInstance {
  return axios.create({ adapter: createTauriAdapter(identity) });
}

const socialClients = new Map<string, AxiosInstance>();

export function socialHttpClient(url: string): AxiosInstance {
  const origin = new URL(url).origin;
  let client = socialClients.get(origin);
  if (!client) {
    const parsed = new URL(origin);
    const resourceId = `social:${parsed.protocol.slice(0, -1)}:${parsed.host.replace(/[^A-Za-z0-9:._-]/g, "_")}`;
    client = createResourceClient({ kind: "site", resourceId });
    socialClients.set(origin, client);
  }
  return client;
}

// Compatibility clients are deliberately local instances. They keep the old packages
// functional while making the privilege and resource identity visible at each boundary.
export const legacySiteHttp = createResourceClient({ kind: "site", resourceId: "site:legacy" });
export const legacyDownloaderHttp = createResourceClient({ kind: "service", resourceId: "downloader:legacy" });
export const legacyBackupHttp = createResourceClient({ kind: "service", resourceId: "backup:legacy" });
