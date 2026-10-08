import type { AxiosInstance } from "axios";
import type { WebDAVClient } from "webdav";
export interface BackupServerDependencies {
  http: AxiosInstance;
  createWebDAV(options: { address: string; loginName: string; loginPwd: string; digest?: boolean }): WebDAVClient;
}
