import axios, { type AxiosInstance } from "axios";

import { createTauriAdapter, type HttpResourceIdentity } from "./tauriAdapter.ts";

export function createResourceClient(identity: HttpResourceIdentity): AxiosInstance {
  return axios.create({ adapter: createTauriAdapter(identity) });
}

// Compatibility clients are deliberately local instances. They keep the old packages
// functional while making the privilege and resource identity visible at each boundary.
export const legacySiteHttp = createResourceClient({ kind: "site", resourceId: "site:legacy" });
export const legacyDownloaderHttp = createResourceClient({ kind: "service", resourceId: "downloader:legacy" });
export const legacyBackupHttp = createResourceClient({ kind: "service", resourceId: "backup:legacy" });
