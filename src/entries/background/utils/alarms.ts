import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";

import { extStorage } from "@/storage.ts";
import { onMessage, sendMessage } from "@/messages.ts";
import { IDownloadTorrentOption, IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { sleep } from "~/helper.ts";

export enum EJobType {
  FlushUserInfo = "flushUserInfo",
  ReDownloadTorrent = "reDownloadTorrent",
  AutoBackup = "autoBackup",
}

function reportTaskFailure(operation: string, error: unknown, data?: Record<string, unknown>) {
  console.error(`[background] ${operation}`, error);
  void sendMessage("logger", { level: "error", module: "background", msg: operation, data }).catch((loggerError) => {
    console.error(`[background] Failed to record task diagnostic: ${operation}`, loggerError);
  });
}

function recordTaskLog(message: string, data?: Record<string, unknown>) {
  void sendMessage("logger", { level: "info", module: "background", msg: message, data }).catch((error) => {
    console.error(`[background] Failed to record task log: ${message}`, error);
  });
}

function runBackgroundTask(operation: string, task: () => Promise<void>) {
  void task().catch((error) => reportTaskFailure(operation, error));
}

export async function runAutoFlushUserInfo(retryIndex = 0): Promise<void> {
  const configStore = await extStorage.getItem("config");
  const {
    enabled = false,
    interval = 1,
    afterTime = "00:00",
    retry: { max: retryMax = 0, interval: retryInterval = 5 } = {},
  } = configStore?.userInfo?.autoReflush ?? {};

  if (!enabled) return;

  const curDate = new Date();
  const curDateFormat = format(curDate, "yyyy-MM-dd");
  let metadataStore = await extStorage.getItem("metadata");
  if (!metadataStore) throw new Error("Auto-refresh requires metadata storage");

  if (retryIndex === 0) {
    const [afterHour, afterMinute] = afterTime.split(":").map((v) => parseInt(v));
    if (curDate.getHours() < afterHour || (curDate.getHours() === afterHour && curDate.getMinutes() < afterMinute)) {
      recordTaskLog("Auto-refreshing user information paused before the allowed refresh time");
      return;
    }

    metadataStore = await extStorage.getItem("metadata");
    if (!metadataStore) throw new Error("Auto-refresh requires metadata storage");
    const lastFlushDateFormat = format(metadataStore.lastUserInfoAutoFlushAt, "yyyy-MM-dd");
    if (curDateFormat === lastFlushDateFormat) {
      const nextFlushTime = metadataStore.lastUserInfoAutoFlushAt + interval * 60 * 60 * 1000;
      if (curDate.getTime() < nextFlushTime) {
        recordTaskLog("Auto-refreshing user information paused until the configured interval elapses");
        return;
      }
    }
  }

  recordTaskLog(`Auto-refreshing user information${retryIndex > 0 ? ` (retry ${retryIndex})` : ""}`);
  let processedSiteCount = 0;
  const failFlushSites: TSiteID[] = [];

  metadataStore = await extStorage.getItem("metadata");
  if (!metadataStore) throw new Error("Auto-refresh requires metadata storage");
  for (const [siteId, siteConfig] of Object.entries(metadataStore.sites)) {
    if (!siteConfig.isOffline && siteConfig.allowQueryUserInfo) {
      try {
        const thisSiteUserInfo = (await sendMessage("getSiteUserInfo", siteId)) ?? {};
        if (typeof thisSiteUserInfo[curDateFormat] === "undefined") {
          const userInfoResult = await sendMessage("getSiteUserInfoResult", siteId);
          if (userInfoResult.status !== EResultParseStatus.success) failFlushSites.push(siteId);
          processedSiteCount += 1;
        }
      } catch (error) {
        failFlushSites.push(siteId);
        reportTaskFailure(`Auto-refresh failed for site ${siteId}`, error);
      }
    }
  }

  recordTaskLog("Auto-refreshing user information finished", { processedSiteCount, failCount: failFlushSites.length });
  metadataStore = await extStorage.getItem("metadata");
  if (!metadataStore) throw new Error("Auto-refresh requires metadata storage");
  metadataStore.lastUserInfoAutoFlushAt = new Date().getTime();
  await extStorage.setItem("metadata", metadataStore);

  if (failFlushSites.length > 0 && retryIndex < retryMax) {
    recordTaskLog("Scheduling auto-refresh retry", { failCount: failFlushSites.length, retryIndex: retryIndex + 1 });
    setTimeout(
      () => {
        runBackgroundTask("Scheduled auto-refresh retry failed", () => runAutoFlushUserInfo(retryIndex + 1));
      },
      retryInterval * 60 * 1000,
    );
  }
}

export async function runAutoBackup(): Promise<void> {
  const metadataStore = (await extStorage.getItem("metadata")) as IMetadataPiniaStorageSchema | null;
  if (!metadataStore?.backupServers) return;

  const now = Date.now();
  for (const [serverId, serverConfig] of Object.entries(metadataStore.backupServers)) {
    if (!serverConfig.enabled || !serverConfig.backupInterval || serverConfig.backupInterval <= 0) continue;

    const intervalMs = serverConfig.backupInterval * 60 * 60 * 1000;
    const lastBackup = serverConfig.lastBackupAt ?? 0;
    if (now - lastBackup < intervalMs) continue;

    recordTaskLog("Auto-backup triggered", { backupServerId: serverId });
    try {
      const ok = await sendMessage("exportBackupData", {
        backupServerId: serverId,
        backupFields: serverConfig.backupFields ?? [],
      });
      if (!ok) {
        reportTaskFailure("Auto-backup returned an unsuccessful result", new Error("exportBackupData returned false"), {
          backupServerId: serverId,
        });
      }
    } catch (error) {
      reportTaskFailure("Auto-backup failed", error, { backupServerId: serverId });
    }
  }
}

const pendingRedownloads = new Map<number, IDownloadTorrentOption>();

async function markRedownloadFailed(downloadId: number, operation: string) {
  try {
    await sendMessage("setDownloadHistoryStatus", { downloadId, status: "failed" });
  } catch (error) {
    reportTaskFailure(`${operation}; failed to persist retry status`, error);
  }
}

export async function handleReDownload(data: IDownloadTorrentOption & { downloadId: number; leftInterval: number }) {
  if (data.leftInterval < 30 * 1000) {
    await sleep(data.leftInterval);
    try {
      await sendMessage("downloadTorrent", data);
    } catch (error) {
      reportTaskFailure("Delayed torrent retry failed", error);
      await markRedownloadFailed(data.downloadId, "Delayed torrent retry failed");
    }
    return;
  }

  pendingRedownloads.set(data.downloadId, data);
  try {
    await invoke("schedule_redownload", { downloadId: String(data.downloadId), delaySecs: 30 });
  } catch (error) {
    pendingRedownloads.delete(data.downloadId);
    reportTaskFailure("Failed to schedule delayed torrent retry", error);
    await markRedownloadFailed(data.downloadId, "Failed to schedule delayed torrent retry");
    throw error;
  }
}

export async function handleScheduledRedownload(downloadId: number): Promise<void> {
  const option = pendingRedownloads.get(downloadId);
  if (!option) {
    reportTaskFailure("Scheduled torrent retry had no pending download", new Error(`Missing download ${downloadId}`));
    return;
  }

  pendingRedownloads.delete(downloadId);
  try {
    await sendMessage("downloadTorrent", option);
  } catch (error) {
    reportTaskFailure("Scheduled torrent retry failed", error);
    await markRedownloadFailed(downloadId, "Scheduled torrent retry failed");
  }
}

onMessage("reDownloadTorrent", async ({ data }) => await handleReDownload(data));

export function registerSchedulerListeners() {
  void listen("scheduler://flush-user-info", () => {
    runBackgroundTask("Auto-refresh scheduler event failed", () => runAutoFlushUserInfo());
  }).catch((error) => reportTaskFailure("Failed to register auto-refresh scheduler listener", error));

  void listen("scheduler://auto-backup", () => {
    runBackgroundTask("Auto-backup scheduler event failed", runAutoBackup);
  }).catch((error) => reportTaskFailure("Failed to register auto-backup scheduler listener", error));

  void listen<string>("scheduler://redownload", (event) => {
    runBackgroundTask("Scheduled torrent retry event failed", () => handleScheduledRedownload(Number(event.payload)));
  }).catch((error) => reportTaskFailure("Failed to register torrent retry scheduler listener", error));
}

registerSchedulerListeners();
