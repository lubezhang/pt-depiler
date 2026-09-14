import { describe, expect, it, vi } from "vitest";

import { DownloadService, DownloadServiceError } from "./service.ts";

const config = { id: "transmission", type: "Transmission", enabled: true };
const torrent = {
  id: 7,
  infoHash: "abc",
  name: "Example",
  progress: 50,
  isCompleted: false,
  ratio: 0.5,
  dateAdded: 100,
  savePath: "/downloads",
  state: "downloading" as const,
  totalSize: 1024,
  uploadSpeed: 1,
  downloadSpeed: 2,
  totalUploaded: 3,
  totalDownloaded: 4,
  trackers: ["https://tracker.example.org/announce"],
  raw: { password: "must-not-leak" },
  clientId: "transmission",
};

function createService(overrides: Record<string, unknown> = {}) {
  const client = {
    getClientVersion: vi.fn().mockResolvedValue("4.0.0, RPC 17"),
    getClientStatus: vi.fn().mockResolvedValue({ upSpeed: 1, dlSpeed: 2, upData: 3, dlData: 4, torrentCount: 1 }),
    getAllTorrents: vi.fn().mockResolvedValue([torrent]),
    pauseTorrent: vi.fn().mockResolvedValue(true),
    resumeTorrent: vi.fn().mockResolvedValue(true),
    removeTorrent: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  return {
    client,
    service: new DownloadService({
      getConfig: vi.fn().mockResolvedValue(config),
      getClient: vi.fn().mockResolvedValue(client),
      now: () => 123,
    }),
  };
}

describe("下载服务用例", () => {
  it("输出可序列化列表摘要而不泄露原始响应", async () => {
    const { service } = createService();
    await expect(service.listTorrents("transmission")).resolves.toEqual([
      expect.objectContaining({ id: 7, infoHash: "abc", totalSize: 1024, trackers: ["https://tracker.example.org/announce"] }),
    ]);
    expect((await service.listTorrents("transmission"))[0]).not.toHaveProperty("raw");
  });

  it("输出精简的种子文件列表", async () => {
    const { service } = createService({
      getTorrentFiles: vi.fn().mockResolvedValue([
        {
          name: "Example/file.mkv",
          length: 100,
          bytesCompleted: 80,
          wanted: true,
          priority: 0,
          raw: { password: "must-not-leak" },
        },
      ]),
    });

    await expect(service.getTorrentFiles("transmission", 7)).resolves.toEqual([
      { name: "Example/file.mkv", length: 100, bytesCompleted: 80, wanted: true, priority: 0 },
    ]);
  });

  it("读取并更新服务端默认下载目录", async () => {
    const getDefaultDownloadDirectory = vi.fn().mockResolvedValue("/downloads/default");
    const setDefaultDownloadDirectory = vi.fn().mockResolvedValue(true);
    const { service } = createService({ getDefaultDownloadDirectory, setDefaultDownloadDirectory });

    await expect(service.getDefaultDownloadDirectory("transmission")).resolves.toBe("/downloads/default");
    await expect(service.setDefaultDownloadDirectory("transmission", "/downloads/media")).resolves.toBe(true);
    expect(setDefaultDownloadDirectory).toHaveBeenCalledWith("/downloads/media");
  });

  it("更新单个种子的数据位置", async () => {
    const setTorrentLocation = vi.fn().mockResolvedValue(true);
    const { service } = createService({ setTorrentLocation });

    await expect(service.setTorrentLocation("transmission", 7, "/downloads/media", true)).resolves.toBe(true);
    expect(setTorrentLocation).toHaveBeenCalledWith(7, "/downloads/media", true);
  });

  it("拒绝已删除、禁用或不支持的服务", async () => {
    const dependencies = { getClient: vi.fn(), getConfig: vi.fn().mockResolvedValue(undefined) };
    const service = new DownloadService(dependencies);
    await expect(service.listTorrents("missing")).rejects.toBeInstanceOf(DownloadServiceError);

    dependencies.getConfig.mockResolvedValue({ ...config, enabled: false });
    await expect(service.listTorrents("transmission")).rejects.toMatchObject({ code: "DOWNLOADER_DISABLED" });

    dependencies.getConfig.mockResolvedValue({ ...config, type: "qBittorrent" });
    await expect(service.listTorrents("qbit")).rejects.toMatchObject({ code: "UNSUPPORTED_DOWNLOADER" });
  });

  it("批量操作保留成功和失败项，删除默认保留本地数据", async () => {
    const { service, client } = createService({
      removeTorrent: vi.fn().mockImplementation(async (id: number) => id === 1),
    });
    await expect(service.removeTorrents("transmission", [1, 2], { deleteData: false })).resolves.toEqual({
      items: [
        { id: 1, success: true },
        { id: 2, success: false, message: "下载服务未确认该操作。" },
      ],
    });
    expect(client.removeTorrent).toHaveBeenCalledWith(1, false);
  });

  it("适配器声明批量能力时合并为一次调用", async () => {
    const pauseTorrents = vi.fn().mockResolvedValue(true);
    const { service, client } = createService({ pauseTorrents });
    await expect(service.stopTorrents("transmission", [1, 2])).resolves.toEqual({
      items: [
        { id: 1, success: true },
        { id: 2, success: true },
      ],
    });
    expect(pauseTorrents).toHaveBeenCalledWith([1, 2]);
    expect(client.pauseTorrent).not.toHaveBeenCalled();
  });
});
