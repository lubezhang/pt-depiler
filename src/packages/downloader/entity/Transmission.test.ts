import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("~/extends/axios/resourceClient.ts", () => ({
  legacyDownloaderHttp: { post: mocks.post },
}));

import Transmission from "./Transmission.ts";
import { CTorrentState } from "../types.ts";

describe("Transmission 管理 RPC", () => {
  it("在 409 协商会话 ID 后只重试一次请求", async () => {
    mocks.post
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, headers: { "x-transmission-session-id": "session-1" } },
      })
      .mockResolvedValueOnce({ data: { result: "success", arguments: {} } });
    const client = new Transmission({ address: "http://localhost:9091" }).configure({
      http: { post: mocks.post } as never,
      torrentHttp: {} as never,
      openWebSocket: vi.fn(),
    });

    await expect(client.pauseTorrent(7)).resolves.toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1][2].headers["X-Transmission-Session-Id"]).toBe("session-1");
  });

  it("仅在 RPC 返回 success 时报告开始、暂停和删除成功", async () => {
    mocks.post.mockResolvedValue({ data: { result: "permission denied", arguments: {} } });
    const client = new Transmission({ address: "http://localhost:9091" }).configure({
      http: { post: mocks.post } as never,
      torrentHttp: {} as never,
      openWebSocket: vi.fn(),
    });

    await expect(client.resumeTorrent(1)).resolves.toBe(false);
    await expect(client.pauseTorrent(1)).resolves.toBe(false);
    await expect(client.removeTorrent(1, false)).resolves.toBe(false);
  });

  it("读取并更新默认下载目录", async () => {
    mocks.post
      .mockResolvedValueOnce({ data: { result: "success", arguments: { "download-dir": "/downloads/default" } } })
      .mockResolvedValueOnce({ data: { result: "success", arguments: {} } });
    const client = new Transmission({ address: "http://localhost:9091" }).configure({
      http: { post: mocks.post } as never,
      torrentHttp: {} as never,
      openWebSocket: vi.fn(),
    });

    await expect(client.getDefaultDownloadDirectory()).resolves.toBe("/downloads/default");
    await expect(client.setDefaultDownloadDirectory("/downloads/media")).resolves.toBe(true);
    expect(mocks.post.mock.calls[1][1]).toEqual({
      method: "session-set",
      arguments: { "download-dir": "/downloads/media" },
    });
  });

  it("更新种子数据位置，并传递移动已有数据的选项", async () => {
    mocks.post.mockResolvedValue({ data: { result: "success", arguments: {} } });
    const client = new Transmission({ address: "http://localhost:9091" }).configure({
      http: { post: mocks.post } as never,
      torrentHttp: {} as never,
      openWebSocket: vi.fn(),
    });

    await expect(client.setTorrentLocation(7, "/downloads/media", true)).resolves.toBe(true);
    expect(mocks.post.mock.calls[0][1]).toEqual({
      method: "torrent-set-location",
      arguments: { ids: 7, location: "/downloads/media", move: true },
    });
  });

  it("请求错误字段、仅保留当前 Tracker，并将错误种子映射为错误状态", async () => {
    mocks.post.mockResolvedValue({
      data: {
        result: "success",
        arguments: {
          torrents: [
            {
              id: 1,
              hashString: "hash",
              name: "broken torrent",
              percentDone: 0.5,
              leftUntilDone: 10,
              uploadRatio: 0,
              addedDate: 1,
              downloadDir: "/downloads",
              status: 4,
              totalSize: 100,
              labels: [],
              rateUpload: 2,
              rateDownload: 3,
              uploadedEver: 4,
              downloadedEver: 5,
              error: 3,
              errorString: "tracker error",
              trackerStats: [
                { announce: "https://active.example.org/announce", isBackup: false },
                { announce: "https://backup.example.org/announce", isBackup: true },
              ],
            },
          ],
        },
      },
    });
    const client = new Transmission({ address: "http://localhost:9091" }).configure({
      http: { post: mocks.post } as never,
      torrentHttp: {} as never,
      openWebSocket: vi.fn(),
    });

    await expect(client.getAllTorrents()).resolves.toEqual([
      expect.objectContaining({
        state: CTorrentState.error,
        uploadSpeed: 2,
        downloadSpeed: 3,
        trackers: ["https://active.example.org/announce"],
      }),
    ]);
    expect(mocks.post.mock.calls[0][1].arguments.fields).toEqual(
      expect.arrayContaining(["error", "errorString", "trackerStats"]),
    );
  });

  it("合并 files 与 fileStats 为文件列表", async () => {
    mocks.post.mockResolvedValue({
      data: {
        result: "success",
        arguments: {
          torrents: [
            {
              files: [
                { name: "movie/video.mkv", length: 100, bytesCompleted: 40 },
                { name: "movie/readme.txt", length: 20, bytesCompleted: 20 },
              ],
              fileStats: [
                { bytesCompleted: 50, wanted: true, priority: 1 },
                { bytesCompleted: 20, wanted: false, priority: -1 },
              ],
            },
          ],
        },
      },
    });
    const client = new Transmission({ address: "http://localhost:9091" }).configure({
      http: { post: mocks.post } as never,
      torrentHttp: {} as never,
      openWebSocket: vi.fn(),
    });

    await expect(client.getTorrentFiles(7)).resolves.toEqual([
      { name: "movie/video.mkv", length: 100, bytesCompleted: 50, wanted: true, priority: 1 },
      { name: "movie/readme.txt", length: 20, bytesCompleted: 20, wanted: false, priority: -1 },
    ]);
    expect(mocks.post.mock.calls[0][1].arguments).toEqual({ ids: [7], fields: ["files", "fileStats"] });
  });
});
