import { format } from "date-fns";
import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";

import { extStorage } from "@/storage.ts";
import { onMessage, sendMessage } from "@/messages.ts";
import { IDownloadTorrentOption, IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { invokeIpc } from "~/extends/tauri/ipc.ts";

export enum EJobType {
  FlushUserInfo = "flushUserInfo",
  ReDownloadTorrent = "reDownloadTorrent",
  AutoBackup = "autoBackup",
}

function reportTaskFailure(operation: string, error: unknown, data?: Record<string, unknown>) {
  console.error("[background] ");
  void sendMessage("logger", { level: "error", module: "background", msg: operation, data }).catch((loggerError) => {
    console.error("[background] Failed to record task diagnostic: ");
  });
}

function recordTaskLog(message: string, data?: Record<string, unknown>) {
  void sendMessage("logger", { level: "info", module: "background", msg: message, data }).catch((error) => {
    console.error("[background] Failed to record task log: ");
  });
}

export async function runAutoFlushUserInfo(retryIndex = 0): Promise<boolean> {
  const configStore = await extStorage.getItem("config");
  const { enabled = false, interval = 1, afterTime = "00:00" } = configStore?.userInfo?.autoReflush ?? {};

  if (!enabled) return true;

  const curDate = new Date();
  const curDateFormat = format(curDate, "yyyy-MM-dd");
  let metadataStore = await extStorage.getItem("metadata");
  if (!metadataStore) throw new Error("Auto-refresh requires metadata storage");

  if (retryIndex === 0) {
    const [afterHour, afterMinute] = afterTime.split(":").map((v) => parseInt(v));
    if (curDate.getHours() < afterHour || (curDate.getHours() === afterHour && curDate.getMinutes() < afterMinute)) {
      recordTaskLog("Auto-refreshing user information paused before the allowed refresh time");
      return true;
    }

    metadataStore = await extStorage.getItem("metadata");
    if (!metadataStore) throw new Error("Auto-refresh requires metadata storage");
    const lastFlushDateFormat = format(metadataStore.lastUserInfoAutoFlushAt, "yyyy-MM-dd");
    if (curDateFormat === lastFlushDateFormat) {
      const nextFlushTime = metadataStore.lastUserInfoAutoFlushAt + interval * 60 * 60 * 1000;
      if (curDate.getTime() < nextFlushTime) {
        recordTaskLog("Auto-refreshing user information paused until the configured interval elapses");
        return true;
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

  return failFlushSites.length === 0;
}

export async function runAutoBackup(onlyServerId?: string, backupFilename?: string): Promise<boolean> {
  if (onlyServerId && !backupFilename) throw new Error("Persistent backup filename is missing");
  const metadataStore = (await extStorage.getItem("metadata")) as IMetadataPiniaStorageSchema | null;
  if (!metadataStore?.backupServers) return true;

  const now = Date.now();
  let successful = true;
  for (const [serverId, serverConfig] of Object.entries(metadataStore.backupServers)) {
    if (onlyServerId && serverId !== onlyServerId) continue;
    if (!serverConfig.enabled || !serverConfig.backupInterval || serverConfig.backupInterval <= 0) continue;

    const intervalMs = serverConfig.backupInterval * 60 * 60 * 1000;
    const lastBackup = serverConfig.lastBackupAt ?? 0;
    if (now - lastBackup < intervalMs) continue;

    recordTaskLog("Auto-backup triggered", { backupServerId: serverId });
    try {
      if (backupFilename) {
        if (await sendMessage("confirmBackupCompletion", { backupServerId: serverId, backupFilename })) return true;
      }
      const ok = await sendMessage("exportBackupData", {
        backupServerId: serverId,
        backupFields: serverConfig.backupFields ?? [],
        ...(backupFilename && { backupFilename }),
      });
      if (!ok) {
        successful = false;
        reportTaskFailure("Auto-backup returned an unsuccessful result", new Error("exportBackupData returned false"), {
          backupServerId: serverId,
        });
      }
    } catch (error) {
      successful = false;
      reportTaskFailure("Auto-backup failed", error, { backupServerId: serverId });
    }
  }
  return successful;
}

async function markRedownloadFailed(downloadId: number, operation: string) {
  try {
    await sendMessage("setDownloadHistoryStatus", { downloadId, status: "failed" });
  } catch (error) {
    reportTaskFailure(`${operation}; failed to persist retry status`, error);
  }
}

export async function handleReDownload(data: IDownloadTorrentOption & { downloadId: number; leftInterval: number }) {
  try {
    await invokeIpc("schedule_redownload", {
      downloadId: String(data.downloadId),
      delaySecs: Math.max(0, Math.ceil(data.leftInterval / 1000)),
    });
  } catch (error) {
    reportTaskFailure("Failed to schedule delayed torrent retry", error);
    await markRedownloadFailed(data.downloadId, "Failed to schedule delayed torrent retry");
    throw error;
  }
}

export async function handleScheduledRedownload(downloadId: number): Promise<"succeeded" | "retry"> {
  const history = await sendMessage("getDownloadHistoryById", downloadId);
  if (!history) throw new Error("Scheduled download history is missing");
  if (history.downloadStatus === "completed") return "succeeded";
  const result = await sendMessage("downloadTorrent", {
    downloadId,
    torrent: history.torrent,
    downloaderId: history.downloaderId,
    addTorrentOptions: history.addTorrentOptions as NonNullable<IDownloadTorrentOption["addTorrentOptions"]>,
  });
  if (result.downloadStatus === "pending") return "retry";
  if (result.downloadStatus === "failed") throw new Error("Scheduled download failed; check remote state before retry");
  return "succeeded";
}

onMessage("reDownloadTorrent", async ({ data }) => await handleReDownload(data));

interface DurableTask {
  id: string;
  kind: "redownload" | "userInfo" | "autoBackup";
  payload: { downloadId?: number; backupServerId?: string; backupFilename?: string };
}

export async function registerSchedulerListeners(): Promise<() => Promise<void>> {
  let stopped = false;
  const active = new Set<Promise<void>>();
  const owner = crypto.randomUUID();
  let polling = false;
  const execute = async (task: DurableTask) => {
    const heartbeat = window.setInterval(() => {
      void invokeIpc("renew_task", { taskId: task.id, owner }).catch((error) =>
        reportTaskFailure("Task lease renewal failed", error, { taskId: task.id }),
      );
    }, 30_000);
    let outcome: "succeeded" | "retry" | "uncertain" = "succeeded";
    try {
      if (task.kind === "redownload") {
        outcome = await handleScheduledRedownload(task.payload.downloadId!);
      } else if (task.kind === "userInfo") {
        outcome = (await runAutoFlushUserInfo()) ? "succeeded" : "retry";
      } else if (task.kind === "autoBackup") {
        outcome = (await runAutoBackup(task.payload.backupServerId, task.payload.backupFilename))
          ? "succeeded"
          : "uncertain";
      } else {
        outcome = "uncertain";
      }
    } catch (error) {
      outcome = "uncertain";
      reportTaskFailure("Task result is uncertain", error, { taskId: task.id });
    } finally {
      window.clearInterval(heartbeat);
    }
    await invokeIpc("finish_task", { taskId: task.id, owner, outcome });
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      await invokeIpc("ensure_periodic_tasks", {});
      for (let index = 0; index < 3 && !stopped; index++) {
        const task = (await invokeIpc("claim_due_task", { owner })) as DurableTask | null;
        if (!task) break;
        const pending = execute(task).catch((error) =>
          reportTaskFailure("Task receipt could not be committed", error, { taskId: task.id }),
        );
        active.add(pending);
        void pending.finally(() => active.delete(pending));
      }
    } catch (error) {
      reportTaskFailure("Durable task polling failed", error);
    } finally {
      polling = false;
    }
  };
  try {
    await invokeIpc("ensure_periodic_tasks", {});
    await poll();
  } catch (error) {
    stopped = true;
    throw error;
  }
  const timer = window.setInterval(() => void poll(), 5_000);
  return async () => {
    stopped = true;
    window.clearInterval(timer);
    await Promise.all([...active]);
    await invokeIpc("release_tasks", { owner });
  };
}
