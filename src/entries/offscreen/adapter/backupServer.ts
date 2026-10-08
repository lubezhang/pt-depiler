import { AuthType, createClient } from "webdav";
import type { BackupServerDependencies } from "@ptd/backupServer";
import { createResourceClient } from "~/extends/axios/resourceClient.ts";
import { installTauriWebDAVTransport, registerTauriWebDAVResource } from "~/extends/axios/tauriWebDAVTransport.ts";
export function backupServerDependencies(id?: string): BackupServerDependencies {
  const http = createResourceClient({ kind: "service", resourceId: id ? `backup:${id}` : "backup:legacy" });
  return {
    http,
    createWebDAV(options) {
      registerTauriWebDAVResource(options.address, http);
      installTauriWebDAVTransport();
      return createClient(options.address, {
        username: options.loginName,
        password: options.loginPwd,
        authType: options.digest ? AuthType.Digest : undefined,
      });
    },
  };
}
