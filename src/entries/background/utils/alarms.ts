import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";

import { extStorage } from "@/storage.ts";
import { onMessage, sendMessage } from "@/messages.ts";
import { IDownloadTorrentOption, IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { sleep } from "~/helper.ts";

/**
 * Tauri 迁移：原 @webext-core/job-scheduler 的周期任务改由 Rust scheduler 通过 event 触发
 * （见 scheduler.rs：flush-user-info 10min、auto-backup 10min）。此处仅保留业务逻辑。
 */

export enum EJobType {
  FlushUserInfo = "flushUserInfo",
  ReDownloadTorrent = "reDownloadTorrent",
  AutoBackup = "autoBackup",
}

function autoFlushUserInfo(retryIndex = 0) {
  return async () => {
    const configStore = (await extStorage.getItem("config"))!;

    const {
      enabled = false,
      interval = 1,
      afterTime = "00:00",
      retry: { max: retryMax = 0, interval: retryInterval = 5 } = {},
    } = configStore?.userInfo?.autoReflush ?? {};

    if (!enabled) {
      return;
    }

    const curDate = new Date();
    const curDateFormat = format(curDate, "yyyy-MM-dd");
    let metadataStore = (await extStorage.getItem("metadata"))!;

    if (retryIndex === 0) {
      const [afterHour, afterMinute] = afterTime.split(":").map((v) => parseInt(v));
      if (curDate.getHours() < afterHour || (curDate.getHours() === afterHour && curDate.getMinutes() < afterMinute)) {
        sendMessage("logger", {
          msg: `Auto-refreshing user information paused since current time is before the allowed refresh time.`,
        }).catch();
        return;
      }

      metadataStore = (await extStorage.getItem("metadata"))!;
      const lastFlushDateFormat = format(metadataStore.lastUserInfoAutoFlushAt, "yyyy-MM-dd");

      if (curDateFormat === lastFlushDateFormat) {
        const nextFlushTime = metadataStore.lastUserInfoAutoFlushAt + interval * 60 * 60 * 1000;
        if (curDate.getTime() < nextFlushTime) {
          sendMessage("logger", {
            msg: `Auto-refreshing user information paused since refresh interval not reached.`,
          }).catch();
          return;
        }
      }
    }

    sendMessage("logger", {
      msg: `Auto-refreshing user information at ${curDateFormat}${retryIndex > 0 ? `(Retry #${retryIndex})` : ""}`,
    }).catch();

    let processedSiteCount = 0;
    const failFlushSites: TSiteID[] = [];

    metadataStore = (await extStorage.getItem("metadata"))!;
    for (const [siteId, siteConfig] of Object.entries(metadataStore.sites)) {
      if (!siteConfig.isOffline && siteConfig.allowQueryUserInfo) {
        try {
          const thisSiteUserInfo = (await sendMessage("getSiteUserInfo", siteId)) ?? {};
          if (typeof thisSiteUserInfo[curDateFormat] === "undefined") {
            const userInfoResult = await sendMessage("getSiteUserInfoResult", siteId);
            if (userInfoResult.status !== EResultParseStatus.success) {
              failFlushSites.push(siteId);
            }
            processedSiteCount += 1;
          }
        } catch (e) {
          failFlushSites.push(siteId);
        }
      }
    }

    sendMessage("logger", {
      msg: `Auto-refreshing user information finished, ${processedSiteCount} sites processed, ${failFlushSites.length} failed.`,
      data: { failFlushSites },
    }).catch();

    metadataStore = (await extStorage.getItem("metadata"))!;
    metadataStore.lastUserInfoAutoFlushAt = new Date().getTime();
    await extStorage.setItem("metadata", metadataStore);

    if (failFlushSites.length > 0 && retryIndex < retryMax) {
      sendMessage("logger", {
        msg: `Retrying auto-refresh for ${failFlushSites.length} failed sites in ${retryInterval} minutes (Retry #${retryIndex + 1})`,
      }).catch();
      setTimeout(() => autoFlushUserInfo(retryIndex + 1)().catch(() => {}), retryInterval * 60 * 1000);
    }
  };
}

function autoBackup() {
  return async () => {
    const metadataStore = (await extStorage.getItem("metadata")) as IMetadataPiniaStorageSchema | undefined;
    if (!metadataStore?.backupServers) {
      return;
    }

    const now = Date.now();

    for (const [serverId, serverConfig] of Object.entries(metadataStore.backupServers)) {
      if (!serverConfig.enabled || !serverConfig.backupInterval || serverConfig.backupInterval <= 0) {
        continue;
      }

      const intervalMs = serverConfig.backupInterval * 60 * 60 * 1000;
      const lastBackup = serverConfig.lastBackupAt ?? 0;

      if (now - lastBackup >= intervalMs) {
        sendMessage("logger", {
          msg: `Auto-backup triggered for [${serverConfig.name}] (interval: ${serverConfig.backupInterval}h)`,
        }).catch();

        try {
          const backupFields = serverConfig.backupFields ?? [];
          const ok = await sendMessage("exportBackupData", {
            backupServerId: serverId,
            backupFields,
          });

          if (!ok) {
            sendMessage("logger", {
              msg: `Auto-backup failed for [${serverConfig.name}] (returned false)`,
            }).catch();
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          sendMessage("logger", {
            msg: `Auto-backup failed for [${serverConfig.name}]: ${errMsg}`,
          }).catch();
        }
      }
    }
  };
}

// reDownloadTorrent 需要完整 downloadOption，Rust schedule_redownload 只回调 downloadId，
// 故在此内存 map 暂存 downloadId -> downloadOption。
const pendingRedownloads = new Map<number, IDownloadTorrentOption>();

onMessage("reDownloadTorrent", async ({ data }) => {
  if (data.leftInterval < 30 * 1000) {
    await sleep(data.leftInterval);
    try {
      await sendMessage("downloadTorrent", data);
    } catch {
      sendMessage("setDownloadHistoryStatus", { downloadId: data.downloadId, status: "failed" }).catch();
    }
  } else {
    pendingRedownloads.set(data.downloadId, data);
    invoke("schedule_redownload", { downloadId: String(data.downloadId), delaySecs: 30 }).catch(() => {
      sendMessage("setDownloadHistoryStatus", { downloadId: data.downloadId, status: "failed" }).catch();
    });
  }
});

// 监听 Rust scheduler event，触发对应业务
listen("scheduler://flush-user-info", () => autoFlushUserInfo()().catch(() => {})).catch(() => {});
listen("scheduler://auto-backup", () => autoBackup()().catch(() => {})).catch(() => {});
listen<string>("scheduler://redownload", (event) => {
  const downloadId = Number(event.payload);
  const opt = pendingRedownloads.get(downloadId);
  if (opt) {
    pendingRedownloads.delete(downloadId);
    sendMessage("downloadTorrent", opt).catch(() => {
      sendMessage("setDownloadHistoryStatus", { downloadId, status: "failed" }).catch();
    });
  }
}).catch(() => {});
