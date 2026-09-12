import type { AxiosRequestConfig } from "axios";

import type { ITorrent, TSiteID as TSiteKey } from "@ptd/site";
import type { CAddTorrentOptions, CAddTorrentResult } from "@ptd/downloader";
import type { TDownloaderKey } from "@/shared/types/storages/metadata.ts";

export type TTorrentDownloadKey = number;
export type TTorrentDownloadStatus = "pending" | "downloading" | "completed" | "failed";

export interface IDownloadFileOptions {
  url: string;
  filename?: string;
  headers?: Record<string, string>;
}

export const LocalDownloadMethod = [
  "web", // 打开种子下载链接，仅支持无自定义请求头的 GET 请求，其他情况回落到应用中转
  "browser", // 兼容旧配置名：由 Tauri 原生下载命令保存远程文件
  "extension", // 兼容旧配置名：应用获取并解析种子后保存 Blob
] as const;

export type TLocalDownloadMethod = (typeof LocalDownloadMethod)[number];

export interface IDownloadTorrentOption {
  downloadId?: TTorrentDownloadKey;
  torrent: Partial<ITorrent>;
  downloaderId:
    | string // 下载到对应id的下载器中
    | "local"; // （默认）下载为本地文件

  // 是否忽略种子对应站点的下载
  ignoreSiteDownloadInterval?: boolean;

  // 剩余等待时间(估算)
  leftInterval?: number;

  // 当使用下载为本地文件时，可用下面配置项
  localDownloadMethod?: TLocalDownloadMethod; // 不存在时回落到 configStoreRaw?.download?.localDownloadMethod ?? "web"

  // 当下载到对应id的下载器中时
  addTorrentOptions?: CAddTorrentOptions;
}

export interface ITorrentDownloadMetadata extends Pick<ITorrent, "title" | "subTitle" | "url" | "link"> {
  id?: TTorrentDownloadKey; // 每个下载任务生成的唯一id
  siteId: TSiteKey; // 站点id
  torrentId: ITorrent["id"]; // 种子id
  downloaderId: TDownloaderKey | "local"; // 下载器id，注意 local 是一个特殊的关键词，表示本地下载
  downloadAt: number; // 下载时间
  downloadStatus: TTorrentDownloadStatus; // 下载状态
  torrent: ITorrent; // 种子信息
  addTorrentOptions: Partial<CAddTorrentOptions>;

  downloadRequestConfig?: AxiosRequestConfig;
  addTorrentResult?: CAddTorrentResult;
}

export interface IDownloadTorrentResult {
  downloadId: TTorrentDownloadKey;
  downloadStatus: TTorrentDownloadStatus;
  errorMessage?: string;
}
