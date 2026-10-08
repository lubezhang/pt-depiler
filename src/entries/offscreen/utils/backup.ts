import { backupServerDependencies } from "@/offscreen/adapter/backupServer.ts";
import { formatDate } from "date-fns";
import { getBackupServer, IBackupData, IBackupFileInfo } from "@ptd/backupServer";
import { backupDataToJSZipBlob } from "@ptd/backupServer/utils.ts";
import AbstractBackupServer from "@ptd/backupServer/AbstractBackupServer.ts";

import { onMessage, sendMessage } from "@/messages.ts";
import { extStorage } from "@/storage.ts";
import { DefaultBackupFields } from "@/shared/types.ts";
import type { TExtensionStorageKey } from "@/storage.ts";
import type { IRestoreOptions, IMetadataPiniaStorageSchema, TBackupFields, TBackupServerKey } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { RemoteBackupService } from "~/application/backup/remote.ts";
import { BackupService, type BackupExportOptions, type BackupSnapshot } from "~/application/backup/service.ts";
import { publicDownloadHistory, publicKeepUploadTask, publicSearchSnapshot } from "@/shared/security/artifacts.ts";
import { invokeIpc } from "~/extends/tauri/ipc.ts";

export const storageKey = [
  "config",
  "metadata",
  "userInfo",
  "searchResultSnapshot",
  "keepUploadTask",
] as TExtensionStorageKey[];

const backupService = new BackupService({
  snapshot: async (includeCookies) => (await invokeIpc("get_backup_snapshot", { includeCookies })) as BackupSnapshot,
  commit: (expectedRevision, data, cookies) =>
    invokeIpc("restore_backup_snapshot", { expectedRevision, data, cookies: cookies as never }),
  sanitize: (field, value) => {
    if (field === "downloadHistory") return value.map(publicDownloadHistory);
    if (field === "keepUploadTask")
      return Object.fromEntries(Object.entries(value).map(([id, task]) => [id, publicKeepUploadTask(task as never)]));
    if (field === "searchResultSnapshot")
      return Object.fromEntries(
        Object.entries(value).map(([id, snapshot]) => [id, publicSearchSnapshot(snapshot as never)]),
      );
    return value;
  },
  now: Date.now,
  get version() {
    return `PT-Depiler (${__APP_VERSION__})`;
  },
});

export async function createBackupData(
  backupFields: TBackupFields[] = DefaultBackupFields,
  options: BackupExportOptions = {},
): Promise<IBackupData> {
  return (await backupService.prepareExport(backupFields, options)).data;
}

export async function getBackupServerInstance(backupServerId: TBackupServerKey): Promise<AbstractBackupServer<any>> {
  logger({ msg: `Get backup server instance for ID: ${backupServerId}` });
  const metadataStore = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema;
  const backupServerConfig = metadataStore.backupServers[backupServerId];
  return await getBackupServer(backupServerConfig, backupServerDependencies(backupServerId));
}

const remoteBackup = new RemoteBackupService({
  config: async (id) => (await extStorage.getItem("metadata"))?.backupServers?.[id],
  create: (config) => getBackupServer(config, backupServerDependencies(config.id)),
  recordSuccess: recordBackupSuccess,
});

async function recordBackupSuccess(backupServerId: string): Promise<void> {
  const metadata = await extStorage.getItem("metadata");
  if (!metadata?.backupServers?.[backupServerId]) throw new Error("Backup server is unavailable");
  metadata.backupServers[backupServerId].lastBackupAt = Math.max(
    metadata.backupServers[backupServerId].lastBackupAt ?? 0,
    Date.now(),
  );
  await extStorage.setItem("metadata", metadata);
}

export async function exportBackupData(
  backupServerId: string | "local",
  backupFields: TBackupFields[] = DefaultBackupFields,
  backupFilename = `PTD_backup_${formatDate(new Date(), "yyyyMMdd'T'HHmm")}.zip`,
  options: BackupExportOptions = {},
): Promise<boolean> {
  const { data: backupData, encryptionKey } = await backupService.prepareExport(backupFields, options);
  if (!/^PTD_backup_(?:task_[0-9]+|[0-9]{8}T[0-9]{4})\.zip$/.test(backupFilename)) {
    throw new Error("Invalid backup filename");
  }

  logger({ msg: `Exporting backup data to ${backupServerId}`, data: { backupFields, backupFilename } });
  if (backupServerId === "local") {
    const jsZipBlob = await backupDataToJSZipBlob(backupData, encryptionKey);
    const blobUrl = URL.createObjectURL(jsZipBlob);
    await sendMessage("downloadFile", { url: blobUrl, filename: backupFilename });
    return true;
  } else {
    return remoteBackup.export(backupServerId, backupFilename, backupData, encryptionKey);
  }
}

onMessage(
  "exportBackupData",
  async ({ data: { backupServerId, backupFields, backupFilename, includeCredentials } }) => {
    return await exportBackupData(backupServerId, backupFields, backupFilename, { includeCredentials });
  },
);

export async function confirmBackupCompletion(backupServerId: string, backupFilename: string): Promise<boolean> {
  if (!/^PTD_backup_task_[0-9]+\.zip$/.test(backupFilename)) throw new Error("Invalid task backup filename");
  return remoteBackup.confirm(backupServerId, backupFilename);
}

onMessage("confirmBackupCompletion", async ({ data: { backupServerId, backupFilename } }) => {
  return await confirmBackupCompletion(backupServerId, backupFilename);
});

export async function restoreBackupData(
  restoreData: IBackupData,
  restoreOptions: IRestoreOptions = {},
): Promise<boolean> {
  return backupService.restore(restoreData, restoreOptions);
}

onMessage("restoreBackupData", async ({ data: { restoreData, restoreOptions = {} } }) => {
  return await restoreBackupData(restoreData, restoreOptions);
});

export async function getBackupHistory(backupServerId: string): Promise<IBackupFileInfo[]> {
  return remoteBackup.list(backupServerId);
}

onMessage("getBackupHistory", async ({ data: backupServerId }) => {
  return await getBackupHistory(backupServerId);
});

export async function deleteBackupHistory(backupServerId: string, path: string): Promise<boolean> {
  return remoteBackup.remove(backupServerId, path);
}

onMessage("deleteBackupHistory", async ({ data: { backupServerId, path } }) => {
  return await deleteBackupHistory(backupServerId, path);
});

export async function getRemoteBackupData(
  backupServerId: string,
  path: string,
  decryptKey: string = "",
): Promise<IBackupData> {
  return remoteBackup.read(backupServerId, path, decryptKey);
}

onMessage("getRemoteBackupData", async ({ data: { backupServerId, path, decryptKey = "" } }) => {
  return await getRemoteBackupData(backupServerId, path, decryptKey);
});
