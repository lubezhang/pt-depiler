import type { CTorrent, CTorrentFile, TorrentClientStatus } from "@ptd/downloader";

export type TorrentId = string | number;

export interface DownloadServiceConfig {
  id: string;
  type: string;
  enabled: boolean;
}

export interface DownloadServiceClient {
  getClientStatus(): Promise<TorrentClientStatus>;
  getClientVersion(): Promise<string>;
  getAllTorrents(): Promise<CTorrent[]>;
  getTorrentFiles?(id: TorrentId): Promise<CTorrentFile[]>;
  getDefaultDownloadDirectory?(): Promise<string>;
  setDefaultDownloadDirectory?(path: string): Promise<boolean>;
  setTorrentLocation?(id: TorrentId, location: string, move: boolean): Promise<boolean>;
  pauseTorrent(id: TorrentId): Promise<boolean>;
  removeTorrent(id: TorrentId, removeData?: boolean): Promise<boolean>;
  resumeTorrent(id: TorrentId): Promise<boolean>;
  pauseTorrents?(ids: TorrentId[]): Promise<boolean>;
  removeTorrents?(ids: TorrentId[], removeData: boolean): Promise<boolean>;
  resumeTorrents?(ids: TorrentId[]): Promise<boolean>;
}

export interface ServiceOverview {
  connected: true;
  downloadSpeed: number;
  sessionDownloaded: number;
  sessionUploaded: number;
  torrentCount: number;
  updatedAt: number;
  uploadSpeed: number;
  version: string;
}

export interface TorrentSummary {
  addedAt: number;
  downloadSpeed: number;
  id: TorrentId;
  infoHash: string;
  label?: string;
  name: string;
  progress: number;
  ratio: number;
  savePath: string;
  state: CTorrent["state"];
  totalDownloaded: number;
  totalSize: number;
  totalUploaded: number;
  trackers: string[];
  uploadSpeed: number;
}

export interface TorrentFileSummary {
  bytesCompleted: number;
  length: number;
  name: string;
  priority: number;
  wanted: boolean;
}

export interface BulkResult {
  items: Array<{ id: TorrentId; message?: string; success: boolean }>;
}

export interface DownloadServiceDependencies {
  getClient(id: string): Promise<DownloadServiceClient | null>;
  getConfig(id: string): Promise<DownloadServiceConfig | undefined>;
  now?: () => number;
}

export class DownloadServiceError extends Error {
  constructor(
    public readonly code:
      "DOWNLOADER_DISABLED" | "DOWNLOADER_NOT_FOUND" | "DOWNLOADER_UNAVAILABLE" | "UNSUPPORTED_DOWNLOADER",
    message: string,
  ) {
    super(message);
    this.name = "DownloadServiceError";
  }
}

export class DownloadService {
  private readonly now: () => number;

  constructor(private readonly dependencies: DownloadServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async getOverview(downloaderId: string): Promise<ServiceOverview> {
    const client = await this.getClient(downloaderId);
    const [version, status] = await Promise.all([client.getClientVersion(), client.getClientStatus()]);
    return {
      connected: true,
      version,
      uploadSpeed: status.upSpeed,
      downloadSpeed: status.dlSpeed,
      sessionUploaded: status.upData ?? 0,
      sessionDownloaded: status.dlData ?? 0,
      torrentCount: status.torrentCount ?? 0,
      updatedAt: this.now(),
    };
  }

  async listTorrents(downloaderId: string): Promise<TorrentSummary[]> {
    const client = await this.getClient(downloaderId);
    return (await client.getAllTorrents()).map(toTorrentSummary);
  }

  async getTorrentFiles(downloaderId: string, torrentId: TorrentId): Promise<TorrentFileSummary[]> {
    const client = await this.getClient(downloaderId);
    return (await client.getTorrentFiles?.(torrentId) ?? []).map(toTorrentFileSummary);
  }

  async getDefaultDownloadDirectory(downloaderId: string): Promise<string> {
    const client = await this.getClient(downloaderId);
    if (!client.getDefaultDownloadDirectory) {
      throw new DownloadServiceError("UNSUPPORTED_DOWNLOADER", "该下载服务不支持读取默认下载目录。");
    }
    return await client.getDefaultDownloadDirectory();
  }

  async setDefaultDownloadDirectory(downloaderId: string, path: string): Promise<boolean> {
    const client = await this.getClient(downloaderId);
    if (!client.setDefaultDownloadDirectory) {
      throw new DownloadServiceError("UNSUPPORTED_DOWNLOADER", "该下载服务不支持设置默认下载目录。");
    }
    return await client.setDefaultDownloadDirectory(path);
  }

  async setTorrentLocation(downloaderId: string, torrentId: TorrentId, location: string, move: boolean): Promise<boolean> {
    const client = await this.getClient(downloaderId);
    if (!client.setTorrentLocation) {
      throw new DownloadServiceError("UNSUPPORTED_DOWNLOADER", "该下载服务不支持设置种子数据位置。");
    }
    return await client.setTorrentLocation(torrentId, location, move);
  }

  async startTorrents(downloaderId: string, torrentIds: TorrentId[]): Promise<BulkResult> {
    return await this.runBulk(
      downloaderId,
      torrentIds,
      (client, id) => client.resumeTorrent(id),
      (client, ids) => client.resumeTorrents?.(ids),
    );
  }

  async stopTorrents(downloaderId: string, torrentIds: TorrentId[]): Promise<BulkResult> {
    return await this.runBulk(
      downloaderId,
      torrentIds,
      (client, id) => client.pauseTorrent(id),
      (client, ids) => client.pauseTorrents?.(ids),
    );
  }

  async removeTorrents(
    downloaderId: string,
    torrentIds: TorrentId[],
    options: { deleteData: boolean },
  ): Promise<BulkResult> {
    return await this.runBulk(
      downloaderId,
      torrentIds,
      (client, id) => client.removeTorrent(id, options.deleteData),
      (client, ids) => client.removeTorrents?.(ids, options.deleteData),
    );
  }

  private async getClient(downloaderId: string): Promise<DownloadServiceClient> {
    const config = await this.dependencies.getConfig(downloaderId);
    if (!config) throw new DownloadServiceError("DOWNLOADER_NOT_FOUND", "下载服务配置不存在或已被删除。");
    if (!config.enabled)
      throw new DownloadServiceError("DOWNLOADER_DISABLED", "下载服务未启用，请先在下载器设置中启用。");
    if (config.type !== "Transmission")
      throw new DownloadServiceError("UNSUPPORTED_DOWNLOADER", `暂不支持管理 ${config.type} 下载服务。`);
    const client = await this.dependencies.getClient(downloaderId);
    if (!client) throw new DownloadServiceError("DOWNLOADER_UNAVAILABLE", "下载服务当前不可用。");
    return client;
  }

  private async runBulk(
    downloaderId: string,
    torrentIds: TorrentId[],
    operation: (client: DownloadServiceClient, id: TorrentId) => Promise<boolean>,
    bulkOperation: (client: DownloadServiceClient, ids: TorrentId[]) => Promise<boolean | undefined> | undefined,
  ): Promise<BulkResult> {
    const client = await this.getClient(downloaderId);
    const uniqueIds = [...new Set(torrentIds)];
    try {
      const bulkSuccess = await bulkOperation(client, uniqueIds);
      if (typeof bulkSuccess === "boolean") {
        return {
          items: uniqueIds.map((id) =>
            bulkSuccess ? { id, success: true } : { id, success: false, message: "下载服务未确认该操作。" },
          ),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { items: uniqueIds.map((id) => ({ id, success: false, message })) };
    }
    const items = await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const success = await operation(client, id);
          return success ? { id, success } : { id, success, message: "下载服务未确认该操作。" };
        } catch (error) {
          return { id, success: false, message: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return { items };
  }
}

function toTorrentSummary(torrent: CTorrent): TorrentSummary {
  return {
    id: torrent.id,
    infoHash: torrent.infoHash,
    name: torrent.name,
    label: torrent.label,
    totalSize: torrent.totalSize,
    progress: torrent.progress,
    state: torrent.state,
    uploadSpeed: torrent.uploadSpeed,
    downloadSpeed: torrent.downloadSpeed,
    totalUploaded: torrent.totalUploaded,
    totalDownloaded: torrent.totalDownloaded,
    ratio: torrent.ratio,
    savePath: torrent.savePath,
    addedAt: torrent.dateAdded,
    trackers: torrent.trackers ?? [],
  };
}

function toTorrentFileSummary(file: CTorrentFile): TorrentFileSummary {
  return {
    name: file.name,
    length: file.length,
    bytesCompleted: file.bytesCompleted,
    wanted: file.wanted,
    priority: file.priority,
  };
}
