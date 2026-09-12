// Tauri 单进程本地消息路由。
import type {
  IAdvancedSearchRequestConfig,
  ISearchResult,
  ISiteUserConfig,
  ITorrent,
  IUserInfo,
  TSiteID,
  getFaviconMetadata,
} from "@ptd/site";

import type {
  ISocialInformation,
  ISocialRecommendationItem,
  ISocialRecommendationsResult,
  TSupportSocialSite$1,
} from "@ptd/social";
import type { IBackupData, IBackupFileInfo } from "@ptd/backupServer";
import type { CTorrent, TorrentClientStatus } from "@ptd/downloader";

// 可序列化的种子信息，用于辅种检测
export interface ITorrentInfoForVerification {
  infoHash: string;
  name: string;
  length: number;
  files: Array<{
    path: string;
    length: number;
  }>;
}

import type { TExtensionStorageKey, IExtensionStorageSchema } from "@/storage.ts";
import {
  ILoggerItem,
  IRestoreOptions,
  ITorrentDownloadMetadata,
  TTorrentDownloadKey,
  ISearchData,
  TSearchSnapshotKey,
  TBackupFields,
  TTorrentDownloadStatus,
  IDownloadTorrentOption,
  IDownloadTorrentResult,
  IDownloadFileOptions,
  ICookie,
  ICookieInput,
  ICookieQuery,
  AugmentedRequired,
  IKeepUploadTask,
  TKeepUploadTaskKey,
} from "@/shared/types.ts";

type TMessageMap = Record<string, (data: any) => any>;

interface ProtocolMap extends TMessageMap {
  // 1. 平台服务
  downloadFile(downloadOptions: IDownloadFileOptions): void;
  getExtStorage<T extends TExtensionStorageKey>(key: T): IExtensionStorageSchema[T];
  setExtStorage<T extends TExtensionStorageKey>(data: { key: T; value: IExtensionStorageSchema[T] }): void;
  reDownloadTorrent(data: AugmentedRequired<IDownloadTorrentOption, "downloadId" | "leftInterval">): void;
  getAllCookies(data: ICookieQuery): ICookie[];
  setCookie(data: ICookieInput): void;
  checkAndExtendCookies(url: string): void;

  // 2. 业务服务
  logger(data: ILoggerItem): void;

  // 2.1 站点基础 ( utils/site )
  getSiteUserConfig(data: { siteId: TSiteID; flush?: boolean }): ISiteUserConfig;
  getSiteFavicon(data: { site: TSiteID | getFaviconMetadata; flush?: boolean }): string;
  clearSiteFaviconCache(): void;

  // 2.2 站点搜索、搜索快照 ( utils/search )
  getSiteSearchResult(data: {
    siteId: TSiteID;
    keyword?: string;
    searchEntry?: IAdvancedSearchRequestConfig;
  }): ISearchResult;
  getSearchResultSnapshotData(snapshotId: TSearchSnapshotKey): ISearchData;
  saveSearchResultSnapshotData(data: { snapshotId: TSearchSnapshotKey; data: ISearchData }): void;
  removeSearchResultSnapshotData(snapshotId: TSearchSnapshotKey): void;

  // 2.3 下载器、下载历史 ( utils/download )
  getDownloaderVersion(downloaderId: string): string;
  getDownloaderStatus(downloaderId: string): TorrentClientStatus;
  getTorrentDownloadLink(torrent: ITorrent): string;
  getTorrentInfoForVerification(torrent: ITorrent): ITorrentInfoForVerification;

  getClientTorrents(downloaderId: string): CTorrent[];
  deleteClientTorrent(data: { downloaderId: string; id: any; removeData?: boolean }): boolean;
  pauseClientTorrent(data: { downloaderId: string; id: any }): boolean;
  resumeClientTorrent(data: { downloaderId: string; id: any }): boolean;

  downloadTorrent(data: IDownloadTorrentOption): IDownloadTorrentResult;

  getDownloadHistory(): ITorrentDownloadMetadata[];
  getDownloadHistoryById(downloadId: TTorrentDownloadKey): ITorrentDownloadMetadata;
  setDownloadHistoryStatus(data: { downloadId: TTorrentDownloadKey; status: TTorrentDownloadStatus }): void;
  deleteDownloadHistoryById(downloadId: TTorrentDownloadKey): void;
  clearDownloadHistory(): void;

  // 2.4 用户信息 ( utils/userInfo )
  getSiteUserInfoResult(siteId: TSiteID): IUserInfo;
  cancelUserInfoQueue(): void;
  getSiteUserInfo(siteId: TSiteID): Record<string, IUserInfo>;
  removeSiteUserInfo(data: { siteId: TSiteID; date: string[] }): void;

  // 2.5 社交信息 ( utils/socialInformation )
  getSocialInformation(data: { site: TSupportSocialSite$1; sid: string }): ISocialInformation;
  getSocialRecommendations(data?: {
    flush?: boolean;
    enrichment?: "all" | "none" | "visible";
  }): ISocialRecommendationsResult;
  getSocialRecommendationItem(data: { item: ISocialRecommendationItem; enrichment?: "all" | "visible" }): {
    item: ISocialRecommendationItem;
  };
  clearSocialInformationCache(): void;

  // 2.6 备份/恢复 ( utils/backup )
  exportBackupData(data: { backupServerId: string | "local"; backupFields: TBackupFields[] }): boolean;
  getBackupHistory(data: string): IBackupFileInfo[];
  deleteBackupHistory(data: { backupServerId: string; path: string }): boolean;
  restoreBackupData(data: { restoreData: IBackupData; restoreOptions?: IRestoreOptions }): boolean;
  getRemoteBackupData(data: { backupServerId: string; path: string; decryptKey?: string }): IBackupData;

  // 2.7 辅种任务 ( utils/keepUploadTask )
  getKeepUploadTasks(): IKeepUploadTask[];
  createKeepUploadTask(task: IKeepUploadTask): void;
  updateKeepUploadTask(task: IKeepUploadTask): void;
  deleteKeepUploadTask(taskId: TKeepUploadTaskKey): void;
  clearKeepUploadTasks(): void;
}

// 全局消息处理函数映射
const messageMaps: Partial<ProtocolMap> = {};

/**
 * sendMessage 优先调用本地 messageMaps 中注册的 handler；无 handler 时抛错（表示该消息尚未迁移到前端 service）。
 */
export function onMessage<K extends keyof ProtocolMap>(
  type: K,
  handler: (message: { data: Parameters<ProtocolMap[K]>[0] }) => void | Promise<ReturnType<ProtocolMap[K]>>,
) {
  messageMaps[type] = handler as ProtocolMap[K];
}

export async function sendMessage<K extends keyof ProtocolMap>(
  type: K,
  data: Parameters<ProtocolMap[K]>[0],
): Promise<ReturnType<ProtocolMap[K]>> {
  const localHandler = messageMaps[type];
  if (localHandler) {
    return await localHandler({ data });
  }
  throw new Error(`[messaging] No handler registered for message "${String(type)}"`);
}
