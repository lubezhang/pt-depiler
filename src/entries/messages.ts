// Tauri 迁移：@webext-core/messaging（依赖 webextension-polyfill）已移除，改为单进程本地路由（见文件末尾）。
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
import type { IMediaServerId, IMediaServerSearchOptions, IMediaServerSearchResult } from "@ptd/mediaServer";
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
  IDownloaderMetadata,
  ISearchData,
  TSearchSnapshotKey,
  TBackupFields,
  TTorrentDownloadStatus,
  IDownloadTorrentOption,
  IDownloadTorrentResult,
  AugmentedRequired,
  IKeepUploadTask,
  TKeepUploadTaskKey,
  BridgeStatus,
} from "@/shared/types.ts";

import { isDebug } from "~/helper.ts";

type TMessageMap = Record<string, (data: any) => any>;

interface ProtocolMap extends TMessageMap {
  // 1. 与 chrome 相关的功能，需要在 service worker 中注册，主要供 offscreen, options 使用
  ping<T extends any>(data?: T): T extends undefined ? "pong" : T;
  openOptionsPage(url?: string | { path: string; query?: Record<string, any> }): void;

  // 1.1 chrome.downloads
  downloadFile(downloadOptions: chrome.downloads.DownloadOptions): number;

  // 1.2 chrome.storage
  getExtStorage<T extends TExtensionStorageKey>(key: T): IExtensionStorageSchema[T];
  setExtStorage<T extends TExtensionStorageKey>(data: { key: T; value: IExtensionStorageSchema[T] }): void;

  // 1.3 chrome.declarativeNetRequest
  updateDNRSessionRules(data: { rule: chrome.declarativeNetRequest.Rule; extOnly?: boolean }): void;
  removeDNRSessionRuleById(data: chrome.declarativeNetRequest.Rule["id"]): void;

  // 1.4 chrome.alarms
  reDownloadTorrent(data: AugmentedRequired<IDownloadTorrentOption, "downloadId" | "leftInterval">): void;

  // 1.5 chrome.cookies
  getAllCookies(data: chrome.cookies.GetAllDetails): chrome.cookies.Cookie[];
  setCookie(data: chrome.cookies.SetDetails): void;
  getCookie(data: chrome.cookies.CookieDetails): chrome.cookies.Cookie | null;
  removeCookie(data: chrome.cookies.CookieDetails | chrome.cookies.SetDetails): chrome.cookies.CookieDetails;
  checkAndExtendCookies(url: string): void;

  // 1.6 chrome.notifications
  showNotification(data: { options: chrome.notifications.NotificationOptions; timeout?: number }): void;

  // 1.7 chrome.contextMenus
  addContextMenu(data: chrome.contextMenus.CreateProperties): string;
  removeContextMenu(data: string): void;
  clearContextMenus(): void;

  // 2. 在 offscreen 中注册，涉及页面解析等功能，主要供 options 使用
  logger(data: ILoggerItem): void;
  getLogger(): ILoggerItem[];
  clearLogger(): void;

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
  getMediaServerSearchResult(data: {
    mediaServerId: IMediaServerId;
    keywords?: string;
    options?: IMediaServerSearchOptions;
  }): IMediaServerSearchResult;
  getSearchResultSnapshotData(snapshotId: TSearchSnapshotKey): ISearchData;
  saveSearchResultSnapshotData(data: { snapshotId: TSearchSnapshotKey; data: ISearchData }): void;
  removeSearchResultSnapshotData(snapshotId: TSearchSnapshotKey): void;

  // 2.3 下载器、下载历史 ( utils/download )
  getDownloaderConfig(downloaderId: string): IDownloaderMetadata;
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
  setSiteLastUserInfo(userInfo: IUserInfo): void;
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
  getKeepUploadTaskById(taskId: TKeepUploadTaskKey): IKeepUploadTask;
  createKeepUploadTask(task: IKeepUploadTask): void;
  updateKeepUploadTask(task: IKeepUploadTask): void;
  deleteKeepUploadTask(taskId: TKeepUploadTaskKey): void;
  clearKeepUploadTasks(): void;

  // 2.8 Lightweight list queries (for CLI discovery)
  getSiteList(): Array<{ id: string; name: string; url: string; offline: boolean }>;
  getDownloaderList(): Array<{ id: string; name: string; type: string; enabled: boolean; address: string }>;

  // 2.9 Native messaging bridge control
  nativeBridgeGetStatus(): BridgeStatus;
  nativeBridgeSetEnabled(data: boolean): BridgeStatus;
  nativeBridgeReconnect(): BridgeStatus;
}

// 全局消息处理函数映射
const messageMaps: Partial<ProtocolMap> = {};

/**
 * Tauri 迁移：单进程本地消息路由。
 * sendMessage 优先调用本地 messageMaps 中注册的 handler；无 handler 时抛错（表示该消息尚未迁移到前端 service）。
 * 原 chrome API 代理类消息（DNR/cookies/contextMenus/omnibox 等）随 background 删除而移除；
 * 少数映射到 Rust 命令（downloadFile/showNotification 等）在 service 层用 invoke 调用。
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
